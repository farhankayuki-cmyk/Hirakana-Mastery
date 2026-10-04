/* kayuki-sync.js — penyambung data Kayuki (Kayuki Latihan, Mensetsu Corner, HiraKana) ke Supabase.
   Tanpa library. Aman dipakai tanpa internet: data masuk antrean di HP dan terkirim saat online.
   Kunci di bawah adalah kunci PUBLIK (boleh terlihat). Keamanan ada di database: tabel tertutup,
   hanya fungsi tertentu yang bisa dipanggil, dan tiap siswa hanya bisa menulis datanya sendiri.

   API untuk aplikasi:
     KayukiSync.init({app:'kayuki'|'mensetsu'|'hirakana'})
     KayukiSync.simpanStatus(kunci, nilai)      // mis. ('mg:p1','hafal') atau ('hira:あ','belum')
     KayukiSync.simpanHasil(objek)              // satu sesi latihan/ujian
     KayukiSync.gabung(kodeKelas, nama)         // Promise
     KayukiSync.keluar()
     KayukiSync.flush()                         // kirim antrean sekarang
     KayukiSync.state()                         // {gabung,nama,kelas,antre,online,terakhir,galat}
     KayukiSync.onChange(fn)                    // dipanggil saat state / masukan sensei berubah
     KayukiSync.masukan()                       // {penilaian:[...], catatan:[...]} dari sensei
     KayukiSync.mountPanel(elemen)              // panel "Gabung kelas" siap pakai
     KayukiSync.sensei.{rekap,detail,nilai,catat}(...)  // khusus sensei */
(function () {
  'use strict';
  var URL_ = 'https://wswpqzffnlmtnpibcpoe.supabase.co';
  var KEY_ = 'sb_publishable_0B-5y-lwaYqaZko5794W2A_XL_vvoPq';
  var APPS = ['kayuki', 'mensetsu', 'hirakana'];
  var LS = { id: 'kayuki-sync-id', q: 'kayuki-sync-antre', inb: 'kayuki-sync-masukan', sk: 'kayuki-sync-sensei' };
  var app = 'kayuki', ready = false, flushing = false, timer = null, backoff = 0, listeners = [];
  var st = { terakhir: null, galat: '' };

  function rd(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function wr(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function now() { return new Date().toISOString(); }
  function rand(n) {
    var a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function emit() { listeners.forEach(function (f) { try { f(state()); } catch (e) {} }); }

  function ident() { return rd(LS.id, null); }
  function queue() { var q = rd(LS.q, []); return Array.isArray(q) ? q : []; }
  function saveQ(q) { wr(LS.q, q.slice(-600)); }
  function state() {
    var i = ident();
    return { gabung: !!(i && i.token && i.kode), nama: i ? i.nama : '', kelas: i ? i.kelas : '', kode: i ? i.kode : '',
      antre: queue().length, online: navigator.onLine !== false, terakhir: st.terakhir, galat: st.galat, app: app };
  }

  /* ---------- panggilan ke database ---------- */
  function rpc(fn, body) {
    return fetch(URL_ + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: KEY_, Authorization: 'Bearer ' + KEY_, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) { var e = new Error((j && j.message) || ('http_' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  var PESAN = {
    kode_kelas_salah: 'Kode kelas tidak ditemukan. Cek lagi dengan sensei.',
    data_tidak_valid: 'Isi nama dan kode kelas dulu.',
    siswa_tidak_dikenal: 'Perangkat ini belum terdaftar. Gabung kelas lagi.',
    akses_ditolak: 'Kode kelas atau kunci sensei salah.',
    siswa_tidak_ditemukan: 'Siswa tidak ditemukan di kelas ini.'
  };
  function pesan(e) { return PESAN[e && e.message] || (e && e.status ? 'Server menolak (' + e.status + ').' : 'Tidak ada internet.'); }

  /* ---------- antrean ---------- */
  function normApp(a) {
    if (APPS.indexOf(a) >= 0) return a;
    return /hirakana/i.test(location.hostname) ? 'hirakana' : 'kayuki';
  }
  function push(item) {
    var q = queue();
    if (item.t === 's') q = q.filter(function (x) { return !(x.t === 's' && x.a === item.a && x.k === item.k); });
    q.push(item); saveQ(q); emit(); schedule(1500);
  }
  function simpanStatus(k, v) {
    if (!ready || k == null || v == null) return Promise.resolve();
    push({ t: 's', a: app, k: String(k).slice(0, 120), v: String(v).slice(0, 40), at: now() });
    return Promise.resolve();
  }
  function simpanHasil(x) {
    if (!ready || x == null) return Promise.resolve();
    try { if (JSON.stringify(x).length > 15000 && x.detail) { x = JSON.parse(JSON.stringify(x)); delete x.detail; } } catch (e) {}
    push({ t: 'h', a: app, id: (x && x.id && String(x.id).slice(0, 64)) || (Date.now().toString(36) + '-' + rand(6)), at: now(), d: x });
    return Promise.resolve();
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(flush, ms); }

  function flush() {
    var i = ident();
    if (flushing || !i || !i.token) return Promise.resolve(false);
    if (navigator.onLine === false) { emit(); return Promise.resolve(false); }
    var q = queue();
    flushing = true;
    var S = q.filter(function (x) { return x.t === 's'; }).slice(0, 200);
    var H = q.filter(function (x) { return x.t === 'h'; }).slice(0, 50);
    return rpc('sinkron', {
      p_token: i.token,
      p_status: S.map(function (x) { return { a: x.a, k: x.k, v: x.v, at: x.at }; }),
      p_hasil: H.map(function (x) { return { a: x.a, id: x.id, at: x.at, d: x.d }; })
    }).then(function (r) {
      var sent = {}; S.concat(H).forEach(function (x) { sent[x.t + '|' + (x.id || x.k) + '|' + x.at] = 1; });
      saveQ(queue().filter(function (x) { return !sent[x.t + '|' + (x.id || x.k) + '|' + x.at]; }));
      if (r) wr(LS.inb, { penilaian: r.penilaian || [], catatan: r.catatan || [], waktu: now() });
      st.terakhir = now(); st.galat = ''; backoff = 0; flushing = false; emit();
      if (queue().length) schedule(800);
      return true;
    }).catch(function (e) {
      flushing = false;
      if (e && e.message === 'siswa_tidak_dikenal') { st.galat = pesan(e); backoff = 0; }
      else { st.galat = pesan(e); backoff = Math.min(300000, backoff ? backoff * 2 : 5000); schedule(backoff); }
      emit(); return false;
    });
  }

  /* ---------- gabung kelas ---------- */
  function gabung(kode, nama) {
    kode = String(kode || '').trim(); nama = String(nama || '').trim();
    if (!kode || !nama) return Promise.reject(new Error(PESAN.data_tidak_valid));
    var old = ident(), token = (old && old.token) || rand(24);
    return rpc('gabung', { p_kode: kode, p_nama: nama, p_token: token }).then(function (r) {
      wr(LS.id, { token: token, nama: nama, kode: kode.toUpperCase(), kelas: r.kelas, siswa: r.siswa });
      emit(); schedule(300); return r;
    }).catch(function (e) { throw new Error(pesan(e)); });
  }
  function keluar() { try { localStorage.removeItem(LS.id); localStorage.removeItem(LS.inb); } catch (e) {} emit(); }

  /* ---------- sensei ---------- */
  function sk() { return rd(LS.sk, null); }
  var sensei = {
    simpanKunci: function (kode, key) { wr(LS.sk, { kode: String(kode || '').trim().toUpperCase(), key: String(key || '').trim() }); },
    kunci: sk,
    lupa: function () { try { localStorage.removeItem(LS.sk); } catch (e) {} },
    rekap: function () { var k = sk(); if (!k) return Promise.reject(new Error('Belum masuk sebagai sensei.')); return rpc('sensei_rekap', { p_kode: k.kode, p_key: k.key }).catch(function (e) { throw new Error(pesan(e)); }); },
    detail: function (siswa) { var k = sk(); return rpc('sensei_detail', { p_kode: k.kode, p_key: k.key, p_siswa: siswa }).catch(function (e) { throw new Error(pesan(e)); }); },
    nilai: function (siswa, a, sc, catatan, oleh) { var k = sk(); return rpc('sensei_nilai', { p_kode: k.kode, p_key: k.key, p_siswa: siswa, p_app: a, p_sc: sc, p_catatan: catatan || '', p_oleh: oleh || '' }).catch(function (e) { throw new Error(pesan(e)); }); },
    catat: function (siswa, a, kunci, status, catatan, teks, oleh) { var k = sk(); return rpc('sensei_catat', { p_kode: k.kode, p_key: k.key, p_siswa: siswa, p_app: a, p_k: kunci, p_st: status, p_catatan: catatan || '', p_teks: teks || '', p_oleh: oleh || '' }).catch(function (e) { throw new Error(pesan(e)); }); }
  };

  /* ---------- panel siap pakai ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function css() {
    if (document.getElementById('ks-css')) return;
    var s = document.createElement('style'); s.id = 'ks-css';
    s.textContent = '.ks{display:flex;flex-direction:column;gap:8px;font-size:14px}.ks input{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-width:0;flex:1}.ks .r{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ks button{font:inherit;font-weight:700;padding:9px 14px;border-radius:10px;border:1.5px solid var(--line,#d6e1f7);background:var(--surface,#fff);color:var(--ink,#0e1c48);cursor:pointer}.ks button.p{background:#1d63d8;border-color:#1d63d8;color:#fff}.ks .m{color:var(--ink-2,#4b5b88);font-size:12.5px}.ks .e{color:#c0392b;font-size:12.5px}.ks .ok{color:#1f9d6b;font-weight:700}.ks .kt{overflow-x:auto}.ks table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}.ks th,.ks td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line,#d6e1f7);white-space:nowrap}.ks th{font-size:12px;color:var(--ink-2,#4b5b88);font-weight:600}.ks tr.c{cursor:pointer}.ks .kd{border-top:1.5px solid var(--line,#d6e1f7);padding-top:10px;display:flex;flex-direction:column;gap:8px}.ks .sc{display:inline-flex;gap:4px}.ks .sc button{padding:6px 10px}.ks select{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-width:0}.ks textarea{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-height:64px}';
    document.head.appendChild(s);
  }
  function fmtT(iso) { try { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  var panelPaint = null, showSen = false;
  function senseiLink() {
    return '<div class="ks" style="margin-top:10px"><div class="r"><button data-ks="sen">' + (showSen ? 'Tutup mode sensei' : 'Saya sensei') + '</button></div>' + (showSen ? '<div id="ks-sensei"></div>' : '') + '</div>';
  }
  function masukanHTML() {
    if (app === 'mensetsu') return '';
    var m = rd(LS.inb, { penilaian: [] }), p = (m.penilaian || []).filter(function (x) { return x.app === app; })[0];
    if (!p) return '';
    var rub = RUBRIK[app] || [];
    return '<div class="m"><b>Penilaian sensei</b> · ' + fmtD(p.waktu) + (p.oleh ? ' · ' + esc(p.oleh) : '') + ' · rata-rata <b>' + avg(p.sc) + '/5</b><br>' +
      p.sc.map(function (v, i) { return esc(rub[i] || ('Aspek ' + (i + 1))) + ' ' + v + '/5'; }).join(' · ') + (p.catatan ? '<br>Catatan: ' + esc(p.catatan) : '') + '</div>';
  }
  function mountPanel(el, o) {
    if (!el) return; css();
    var msg = '';
    function paint() {
      var ae = document.activeElement;
      if (ae && el.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return; /* jangan hapus ketikan yang sedang ditulis */
      var s = state();
      if (s.gabung) {
        el.innerHTML = '<div class="ks"><div><span class="ok">Terhubung</span> ke kelas <b>' + esc(s.kelas) + '</b> sebagai <b>' + esc(s.nama) + '</b></div>' +
          '<div class="m">' + (s.antre ? s.antre + ' data menunggu dikirim' : 'Semua data sudah terkirim') + (s.terakhir ? ' · terakhir ' + fmtT(s.terakhir) : '') + (s.online ? '' : ' · sedang offline') + '</div>' +
          (s.galat ? '<div class="e">' + esc(s.galat) + '</div>' : '') +
          masukanHTML() + '<div class="r"><button data-ks="sync" class="p">Sinkronkan sekarang</button><button data-ks="out">Keluar dari kelas</button></div></div>' + senseiLink();
      } else {
        el.innerHTML = '<div class="ks"><div class="m">Gabung kelas supaya sensei bisa melihat progresmu dan memberi catatan. Tanpa gabung, progres tetap tersimpan di HP ini.</div>' +
          '<div class="r"><input id="ks-kode" placeholder="Kode kelas" autocapitalize="characters" autocomplete="off"><input id="ks-nama" placeholder="Nama lengkap" autocomplete="name" value="' + esc(o && o.nama) + '"></div>' +
          (msg ? '<div class="e">' + esc(msg) + '</div>' : '') +
          '<div class="r"><button data-ks="join" class="p">Gabung kelas</button></div></div>' + senseiLink();
      }
      if (showSen) mountSensei(el.querySelector('#ks-sensei'), o);
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ks]'); if (!b) return;
      var a = b.getAttribute('data-ks');
      if (a === 'sync') { b.textContent = 'Mengirim...'; flush().then(paint); }
      if (a === 'sen') { showSen = !showSen; return paint(); }
      if (a === 'out') { if (confirm('Keluar dari kelas? Data di HP ini tetap ada.')) { keluar(); msg = ''; paint(); } }
      if (a === 'join') {
        var k = el.querySelector('#ks-kode').value, n = el.querySelector('#ks-nama').value;
        b.disabled = true; b.textContent = 'Menghubungkan...';
        gabung(k, n).then(function () { msg = ''; paint(); }).catch(function (er) { msg = er.message; paint(); });
      }
    });
    el.__ksPaintHook = paint;
    var i = listeners.indexOf(panelPaint); if (i >= 0) listeners.splice(i, 1);
    panelPaint = paint; listeners.push(paint); paint();
  }

  /* ---------- dasbor sensei (dipakai di Kayuki, Mensetsu, HiraKana) ---------- */
  var RUBRIK = {
    mensetsu: ['Suara & pelafalan', 'Kontak mata & ekspresi', 'Sikap, duduk & ojigi', 'Isi jawaban', 'Tata bahasa & kesopanan'],
    kayuki: ['Kosakata', 'Tata bahasa', 'Kanji', 'Membaca', 'Kesiapan ujian'],
    hirakana: ['Pengenalan huruf', 'Kecepatan baca', 'Ketepatan', 'Konsistensi latihan']
  };
  var DAFTAR_SENSEI = ['Sopian Sensei', 'Andrian Sensei', 'Farhan Sensei', 'Cania Sensei'];
  function opsiSensei(pilih) {
    var l = DAFTAR_SENSEI.slice(); if (pilih && l.indexOf(pilih) < 0) l.push(pilih);
    return '<option value="">Pilih sensei…</option>' + l.map(function (n) { return '<option' + (n === pilih ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
  }
  var NAMA_APP = { mensetsu: 'Mensetsu', kayuki: 'Kayuki Latihan', hirakana: 'HiraKana' };
  var KMODE = { latihan: 'Latihan', shiken: 'Shiken', kenaikan: 'Ujian kenaikan', penempatan: 'Tes penempatan', simulasi: 'Simulasi', tes: 'Tes' };
  var SS = { rows: null, sel: null, det: null, err: '', busy: false, app: 'mensetsu', sc: null, note: '', nama: rd('kayuki-sync-sn', '') };
  function avg(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return (t / a.length).toFixed(1); }
  function fmtD(iso) { try { return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }); } catch (e) { return ''; } }
  function ringkas(h) {
    var d = h.data || {}, skor = null, tot = null;
    if (d.skor != null && d.total) { skor = d.skor; tot = d.total; }
    else if (d.h != null && d.n) { skor = d.h; tot = d.n; }
    var jenis = (KMODE[d.mode] || d.mode || '-') + (d.bab && !Array.isArray(d.bab) ? ' · ' + d.bab : '') + (d.lulus === true ? ' ✓' : d.lulus === false ? ' ✗' : '');
    return [jenis, tot ? skor + '/' + tot : '–', tot ? Math.round(skor / tot * 100) + '%' : (d.pct != null ? d.pct + '%' : '–')];
  }
  function mountSensei(el, o) {
    if (!el) return; css();
    if (o && o.nama && !SS.nama && DAFTAR_SENSEI.indexOf(o.nama) >= 0) SS.nama = o.nama;
    var root = el;
    function load() {
      SS.busy = true; SS.err = ''; paint();
      return sensei.rekap().then(function (r) { SS.rows = r; return SS.sel ? sensei.detail(SS.sel).then(function (d) { SS.det = d; }) : null; })
        .catch(function (e) { SS.err = e.message; if (!SS.rows) SS.rows = []; })
        .then(function () { SS.busy = false; paint(); });
    }
    function open(id) {
      SS.sel = id; SS.det = null; SS.err = ''; SS.sc = null; SS.note = ''; paint();
      sensei.detail(id).then(function (d) { SS.det = d; paint(); }).catch(function (e) { SS.err = e.message; paint(); });
    }
    function paint() {
      var kk = sk();
      if (!kk) {
        root.innerHTML = '<div class="ks"><div class="m">Masuk dengan kode kelas dan kunci sensei. Kunci hanya tersimpan di HP ini.</div>' +
          '<div class="r"><input id="kso-kode" placeholder="Kode kelas" autocapitalize="characters" autocomplete="off"><input id="kso-key" type="password" placeholder="Kunci sensei" autocomplete="off"></div>' +
          '<div class="r"><select id="kso-nama" aria-label="Sensei yang memeriksa">' + opsiSensei(SS.nama) + '</select></div><div class="m">Pilih nama sensei yang memeriksa. Nama ini muncul di catatan dan penilaian.</div>' +
          (SS.err ? '<div class="e">' + esc(SS.err) + '</div>' : '') +
          '<div class="r"><button class="p" data-kso="login">Masuk</button></div></div>';
        return;
      }
      if (!SS.rows && !SS.busy && !SS.err) { setTimeout(load, 0); }
      var rows = SS.rows || [], h = '<div class="ks"><div class="r" style="justify-content:space-between"><b>Kelas ' + esc(kk.kode) + ' · ' + rows.length + ' siswa</b><span><button data-kso="reload">' + (SS.busy ? 'Memuat...' : 'Muat ulang') + '</button> <button data-kso="logout">Keluar</button></span></div><div class="r"><span class="m">Diperiksa oleh</span><select id="kso-oleh" aria-label="Sensei yang memeriksa">' + opsiSensei(SS.nama) + '</select></div>';
      if (SS.err) h += '<div class="e">' + esc(SS.err) + '</div>';
      if (rows.length) {
        h += '<div class="kt"><table><thead><tr><th>Nama</th><th>Mensetsu</th><th>HiraKana</th><th>Kayuki</th><th>Terakhir</th><th>Nilai</th><th>Aktif</th></tr></thead><tbody>';
        rows.forEach(function (r) {
          var s = r.status || {}, ht = r.hasil_terakhir, nl = r.nilai_terakhir;
          h += '<tr class="c" data-kso-id="' + esc(r.id) + '"><td><b>' + esc(r.nama) + '</b></td><td>' + (s['mensetsu|hafal'] || 0) + '</td><td>' + (s['hirakana|hafal'] || 0) + '</td><td>' + ((s['kayuki|lulus'] || 0) + (s['kayuki|lancar'] || 0)) + ' bab</td><td>' + (ht ? esc(NAMA_APP[ht.app] || ht.app) + ' ' + ringkas(ht)[1] : '–') + '</td><td>' + (nl ? avg(nl.sc) : '–') + '</td><td>' + fmtD(r.terakhir) + '</td></tr>';
        });
        h += '</tbody></table></div><div class="m">Kolom: jumlah item hafal (Mensetsu, HiraKana) dan bab Kayuki yang lulus. Ketuk nama untuk detail.</div>';
      } else if (!SS.busy) h += '<div class="m">Belum ada siswa yang bergabung. Bagikan kode kelas ke siswa.</div>';
      if (SS.sel && SS.det) h += detail();
      else if (SS.sel) h += '<div class="m">Memuat detail...</div>';
      root.innerHTML = h + '</div>';
    }
    function detail() {
      var d = SS.det, cnt = {}, g = { mensetsu: [], kayuki: [], hirakana: [] };
      (d.status || []).forEach(function (x) { var k = x.a + '|' + x.v; cnt[k] = (cnt[k] || 0) + 1; });
      (d.hasil || []).forEach(function (x) { if (g[x.app]) g[x.app].push(x); });
      var rub = RUBRIK[SS.app]; if (!SS.sc || SS.sc.length !== rub.length) SS.sc = rub.map(function () { return 3; });
      var h = '<div class="kd"><div class="r" style="justify-content:space-between"><div><b style="font-size:16px">' + esc(d.nama) + '</b><div class="m">Terakhir aktif ' + fmtD(d.terakhir) + '</div></div><button data-kso="close">Tutup</button></div>';
      Object.keys(g).forEach(function (a) {
        var st = ['hafal', 'ragu', 'belum', 'lulus', 'lancar'].filter(function (v) { return cnt[a + '|' + v]; }).map(function (v) { return v + ' ' + cnt[a + '|' + v]; }).join(' · ');
        if (!g[a].length && !st) return;
        h += '<div class="m" style="margin-top:8px"><b>' + NAMA_APP[a] + '</b>' + (st ? ' · ' + st : '') + '</div>';
        if (g[a].length) {
          h += '<div class="kt"><table><thead><tr><th>Tanggal</th><th>Jenis</th><th>Skor</th><th>Nilai</th></tr></thead><tbody>';
          g[a].slice(0, 6).forEach(function (x) { var r = ringkas(x); h += '<tr><td>' + fmtD(x.waktu) + '</td><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>'; });
          h += '</tbody></table></div>';
        }
      });
      var pen = d.penilaian || [];
      if (pen.length) {
        h += '<div class="m" style="margin-top:8px"><b>Riwayat penilaian tatap muka</b></div><div class="kt"><table><thead><tr><th>Tanggal</th><th>Aplikasi</th><th>Rata²</th><th>Catatan</th></tr></thead><tbody>';
        pen.slice(0, 6).forEach(function (p) { h += '<tr><td>' + fmtD(p.waktu) + '</td><td>' + esc(NAMA_APP[p.app] || p.app) + '</td><td><b>' + avg(p.sc) + '</b></td><td>' + esc(p.catatan || '') + '</td></tr>'; });
        h += '</tbody></table></div>';
      }
      h += '<div class="m" style="margin-top:10px"><b>Penilaian tatap muka baru</b></div><div class="r">' +
        Object.keys(RUBRIK).map(function (a) { return '<button data-kso-app="' + a + '"' + (SS.app === a ? ' class="p"' : '') + '>' + NAMA_APP[a] + '</button>'; }).join('') + '</div>';
      rub.forEach(function (a, i) {
        h += '<div class="r" style="justify-content:space-between"><span>' + esc(a) + '</span><span class="sc">' + [1, 2, 3, 4, 5].map(function (n) { return '<button data-kso-sc="' + i + ':' + n + '"' + (SS.sc[i] === n ? ' class="p"' : '') + '>' + n + '</button>'; }).join('') + '</span></div>';
      });
      h += '<textarea id="kso-note" placeholder="Catatan untuk siswa…">' + esc(SS.note) + '</textarea><div class="r"><button class="p" data-kso="nilai">Kirim penilaian ke siswa</button><span class="m">Rata-rata ' + avg(SS.sc) + '/5 · diterima siswa saat online</span></div></div>';
      return h;
    }
    if (!root.__kso) {
      root.__kso = true;
      root.addEventListener('input', function (e) { if (e.target && e.target.id === 'kso-note') SS.note = e.target.value; });
      root.addEventListener('change', function (e) { var t = e.target; if (t && (t.id === 'kso-nama' || t.id === 'kso-oleh')) { SS.nama = t.value; wr('kayuki-sync-sn', SS.nama); } });
      root.addEventListener('click', function (e) {
        var t = e.target; if (!t || !t.closest) return;
        var row = t.closest('[data-kso-id]'); if (row) return open(row.getAttribute('data-kso-id'));
        var ap = t.closest('[data-kso-app]'); if (ap) { SS.app = ap.getAttribute('data-kso-app'); SS.sc = null; return paint(); }
        var sc = t.closest('[data-kso-sc]'); if (sc) { var p = sc.getAttribute('data-kso-sc').split(':'); SS.sc[+p[0]] = +p[1]; return paint(); }
        var b = t.closest('[data-kso]'); if (!b) return; var a = b.getAttribute('data-kso');
        if (a === 'login') {
          var k = (root.querySelector('#kso-kode') || {}).value, key = (root.querySelector('#kso-key') || {}).value;
          SS.nama = (root.querySelector('#kso-nama') || {}).value || ''; wr('kayuki-sync-sn', SS.nama);
          if (!k || !key) { SS.err = 'Isi kode kelas dan kunci sensei.'; return paint(); }
          if (!SS.nama) { SS.err = 'Pilih nama sensei yang memeriksa.'; return paint(); }
          sensei.simpanKunci(k, key); SS.rows = null; SS.err = '';
          return sensei.rekap().then(function (r) { SS.rows = r; paint(); }).catch(function (er) { sensei.lupa(); SS.err = er.message; paint(); });
        }
        if (a === 'logout') { sensei.lupa(); SS.rows = null; SS.sel = null; SS.det = null; SS.err = ''; return paint(); }
        if (a === 'reload') return load();
        if (a === 'close') { SS.sel = null; SS.det = null; return paint(); }
        if (a === 'nilai' && SS.sel) {
          if (!SS.nama) { SS.err = 'Pilih dulu sensei yang memeriksa (di atas).'; return paint(); }
          b.disabled = true; b.textContent = 'Mengirim...';
          sensei.nilai(SS.sel, SS.app, SS.sc.slice(), SS.note, SS.nama).then(function () { SS.note = ''; SS.sc = null; return load(); })
            .catch(function (er) { SS.err = er.message; paint(); });
        }
      });
    }
    paint();
  }

  function init(o) {
    app = normApp(o && o.app); ready = true;
    window.addEventListener('online', function () { schedule(500); emit(); });
    window.addEventListener('offline', emit);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') schedule(800); });
    setInterval(function () { if (queue().length) flush(); }, 60000);
    schedule(2000);
  }

  window.KayukiSync = {
    init: init, simpanStatus: simpanStatus, simpanHasil: simpanHasil, gabung: gabung, keluar: keluar, flush: flush,
    state: state, onChange: function (f) { listeners.push(f); }, masukan: function () { return rd(LS.inb, { penilaian: [], catatan: [] }); },
    mountPanel: mountPanel, mountSensei: mountSensei, daftarSensei: DAFTAR_SENSEI, sensei: sensei, versi: 4
  };
})();
