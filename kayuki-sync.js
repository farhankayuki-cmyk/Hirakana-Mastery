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
    siswa_tidak_ditemukan: 'Siswa tidak ditemukan di kelas ini.',
    bukti_sakit_wajib: 'Untuk status Sakit, pilih bukti: dicek di asrama atau surat dokter.',
    data_izin_wajib: 'Untuk status Izin, isi keperluan dan centang berkas izin sudah ditandatangani sensei.'
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
    hasilKelas: function (a, mode) { var k = sk(); if (!k) return Promise.reject(new Error('Belum masuk sebagai sensei.')); return rpc('sensei_hasil_kelas', { p_kode: k.kode, p_key: k.key, p_app: a, p_mode: mode }).catch(function (e) { throw new Error(pesan(e)); }); },
    hadirAmbil: function (dari, sampai) { var k = sk(); return rpc('sensei_hadir_ambil', { p_kode: k.kode, p_key: k.key, p_dari: dari, p_sampai: sampai }).catch(function (e) { throw new Error(pesan(e)); }); },
    hadirSimpan: function (tgl, items, oleh) { var k = sk(); return rpc('sensei_hadir_simpan', { p_kode: k.kode, p_key: k.key, p_tanggal: tgl, p_items: items, p_oleh: oleh || '' }).catch(function (e) { throw new Error(pesan(e)); }); },
    periode: function (dari, sampai) { var k = sk(); return rpc('sensei_rekap_periode', { p_kode: k.kode, p_key: k.key, p_dari: dari, p_sampai: sampai }).catch(function (e) { throw new Error(pesan(e)); }); },
    catat: function (siswa, a, kunci, status, catatan, teks, oleh) { var k = sk(); return rpc('sensei_catat', { p_kode: k.kode, p_key: k.key, p_siswa: siswa, p_app: a, p_k: kunci, p_st: status, p_catatan: catatan || '', p_teks: teks || '', p_oleh: oleh || '' }).catch(function (e) { throw new Error(pesan(e)); }); }
  };

  /* ---------- panel siap pakai ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function css() {
    if (document.getElementById('ks-css')) return;
    var s = document.createElement('style'); s.id = 'ks-css';
    s.textContent = '.ks{display:flex;flex-direction:column;gap:8px;font-size:14px}.ks input{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-width:0;flex:1}.ks .r{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ks button{font:inherit;font-weight:700;padding:9px 14px;border-radius:10px;border:1.5px solid var(--line,#d6e1f7);background:var(--surface,#fff);color:var(--ink,#0e1c48);cursor:pointer}.ks button.p{background:#1d63d8;border-color:#1d63d8;color:#fff}.ks .m{color:var(--ink-2,#4b5b88);font-size:12.5px}.ks .e{color:#c0392b;font-size:12.5px}.ks .ok{color:#1f9d6b;font-weight:700}.ks .kt{overflow-x:auto}.ks table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}.ks th,.ks td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line,#d6e1f7);white-space:nowrap}.ks th{font-size:12px;color:var(--ink-2,#4b5b88);font-weight:600}.ks tr.c{cursor:pointer}.ks .kd{border-top:1.5px solid var(--line,#d6e1f7);padding-top:10px;display:flex;flex-direction:column;gap:8px}.ks .sc{display:inline-flex;gap:4px}.ks .sc button{padding:6px 10px}.ks select{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-width:0}.ks input[type=checkbox]{flex:none;width:auto;min-width:0}.ks input[type=date]{flex:none}.ks .tabs{display:flex;gap:6px;flex-wrap:wrap}.ks .tabs button.on{background:#0e1c48;border-color:#0e1c48;color:#fff}.ks button.s-hadir{background:#1f9d6b;border-color:#1f9d6b;color:#fff}.ks button.s-alfa{background:#c0392b;border-color:#c0392b;color:#fff}.ks button.s-sakit{background:#d98e0b;border-color:#d98e0b;color:#fff}.ks button.s-izin{background:#1d63d8;border-color:#1d63d8;color:#fff}.ks .hd{border-top:1px solid var(--line,#d6e1f7);padding-top:8px;display:flex;flex-direction:column;gap:6px}.ks .hd .sc button{padding:7px 11px}.ks textarea{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-height:64px}';
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
  var SS = { rows: null, sel: null, det: null, err: '', busy: false, app: 'mensetsu', sc: null, note: '', nama: rd('kayuki-sync-sn', ''),
    tab: 'siswa', hd: { tgl: hariIni(), m: {}, busy: false, msg: '', ok: false }, rk: { mulai: senin(hariIni()), data: null, busy: false, msg: '' } };
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
      var rows = SS.rows || [], h = '<div class="ks"><div class="r" style="justify-content:space-between"><b>Kelas ' + esc(kk.kode) + ' · ' + rows.length + ' siswa</b><span><button data-kso="reload">' + (SS.busy ? 'Memuat...' : 'Muat ulang') + '</button> <button data-kso="logout">Keluar</button></span></div><div class="r"><span class="m">Diperiksa oleh</span><select id="kso-oleh" aria-label="Sensei yang memeriksa">' + opsiSensei(SS.nama) + '</select></div>' + tabsHTML();
      if (SS.err) h += '<div class="e">' + esc(SS.err) + '</div>';
      if (SS.tab === 'hadir') { root.innerHTML = h + hadirHTML(rows) + '</div>'; return; }
      if (SS.tab === 'rekap') { root.innerHTML = h + rekapHTML() + '</div>'; return; }
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
    function tabsHTML() {
      return '<div class="tabs">' + [['siswa', 'Siswa & nilai'], ['hadir', 'Absensi harian'], ['rekap', 'Rekap mingguan']].map(function (t) { return '<button data-kso-tab="' + t[0] + '"' + (SS.tab === t[0] ? ' class="on"' : '') + '>' + t[1] + '</button>'; }).join('') + '</div>';
    }
    function hdMuat() {
      SS.hd.busy = true; SS.hd.ok = false; SS.hd.msg = ''; paint();
      sensei.hadirAmbil(SS.hd.tgl, SS.hd.tgl).then(function (r) {
        var m = {}; r.forEach(function (x) { m[x.siswa] = { st: x.st, bukti: x.bukti || '', ket: x.ket || '' }; });
        SS.hd.m = m; SS.hd.busy = false; paint();
      }).catch(function (e) { SS.hd.busy = false; SS.err = e.message; paint(); });
    }
    function hadirHTML(rows) {
      var H = SS.hd, cnt = { hadir: 0, alfa: 0, sakit: 0, izin: 0, belum: 0 };
      rows.forEach(function (r) { var x = H.m[r.id]; if (x && x.st) cnt[x.st]++; else cnt.belum++; });
      var h = '<div class="r"><input type="date" id="kso-tgl" value="' + esc(H.tgl) + '"><span class="m">' + esc(hariLabel(H.tgl)) + '</span></div>' +
        '<div class="m">Tandai kehadiran tiap siswa. Absensi hanya untuk catatan sensei dan laporan, <b>tidak membatasi akses materi</b> siswa.</div>';
      if (!rows.length) return h + '<div class="m">Belum ada siswa di kelas ini.</div>';
      h += '<div class="r"><button data-kso="hd-semua">Tandai semua hadir</button><span class="m">Hadir ' + cnt.hadir + ' · Alfa ' + cnt.alfa + ' · Sakit ' + cnt.sakit + ' · Izin ' + cnt.izin + ' · Belum ' + cnt.belum + '</span></div>';
      rows.forEach(function (r) {
        var x = H.m[r.id] || {}, id = esc(r.id);
        h += '<div class="hd"><div class="r" style="justify-content:space-between"><b>' + esc(r.nama) + '</b><span class="sc">' +
          ['hadir', 'alfa', 'sakit', 'izin'].map(function (k) { return '<button data-kso-hd="' + id + ':' + k + '"' + (x.st === k ? ' class="s-' + k + '"' : '') + '>' + ({ hadir: 'Hadir', alfa: 'Alfa', sakit: 'Sakit', izin: 'Izin' })[k] + '</button>'; }).join('') + '</span></div>';
        if (x.st === 'sakit') h += '<div class="r"><select data-hd-bukti="' + id + '"><option value="">Pilih bukti sakit…</option><option value="asrama"' + (x.bukti === 'asrama' ? ' selected' : '') + '>Dicek sensei di asrama</option><option value="surat_dokter"' + (x.bukti === 'surat_dokter' ? ' selected' : '') + '>Ada surat dokter (di rumah)</option></select></div>';
        if (x.st === 'izin') h += '<div class="r"><input data-hd-ket="' + id + '" placeholder="Keperluan izin (wajib)" value="' + esc(x.ket) + '"></div><label class="m"><input type="checkbox" data-hd-ttd="' + id + '"' + (x.bukti === 'berkas_ttd' ? ' checked' : '') + '> Berkas izin sudah ditandatangani sensei kelas</label>';
        if (x.st === 'alfa') h += '<div class="m">Tanpa keterangan.</div>';
        h += '</div>';
      });
      h += '<div class="r"><button class="p" data-kso="hd-simpan">' + (H.busy ? 'Memproses...' : 'Simpan absensi') + '</button>' + (H.ok ? '<span class="ok">Tersimpan ✓</span>' : '') + '</div>' + (H.msg ? '<div class="e">' + esc(H.msg) + '</div>' : '');
      return h;
    }
    function hdSimpan() {
      var H = SS.hd, rows = SS.rows || [], bad = [], items = [];
      if (!SS.nama) { H.msg = 'Pilih dulu sensei yang memeriksa (di atas).'; return paint(); }
      rows.forEach(function (r) {
        var x = H.m[r.id] || {};
        if (x.st === 'sakit' && !x.bukti) bad.push(r.nama + ' (bukti sakit)');
        if (x.st === 'izin' && (!(x.ket || '').trim() || x.bukti !== 'berkas_ttd')) bad.push(r.nama + ' (keperluan & berkas izin)');
        items.push({ siswa: r.id, st: x.st || 'kosong', bukti: x.bukti || '', ket: (x.ket || '').trim() });
      });
      if (bad.length) { H.msg = 'Lengkapi dulu: ' + bad.join(', '); return paint(); }
      H.busy = true; H.msg = ''; H.ok = false; paint();
      sensei.hadirSimpan(H.tgl, items, SS.nama).then(function () { H.busy = false; H.ok = true; paint(); })
        .catch(function (e) { H.busy = false; H.msg = e.message; paint(); });
    }
    function rkMuat() {
      var R = SS.rk, dari = R.mulai, sampai = addHari(dari, 6); R.busy = true; R.msg = ''; R.ok = ''; paint();
      Promise.all([sensei.periode(dari, sampai), sensei.hadirAmbil(dari, sampai)]).then(function (a) { R.data = susunRekap(a[0], a[1], dari); R.busy = false; paint(); })
        .catch(function (e) { R.busy = false; R.data = null; R.msg = e.message; paint(); });
    }
    function rekapHTML() {
      var R = SS.rk, h = '<div class="r"><button data-kso-rk="prev">‹ Minggu lalu</button><button data-kso-rk="now">Minggu ini</button><button data-kso-rk="next">Minggu depan ›</button></div>' +
        '<div class="r"><input type="date" id="kso-minggu" value="' + esc(R.mulai) + '"><span class="m">' + esc(tglPanjang(R.mulai) + ' – ' + tglPanjang(addHari(R.mulai, 6))) + ' (Senin–Minggu)</span></div>';
      if (R.msg) h += '<div class="e">' + esc(R.msg) + '</div>';
      if (R.busy) return h + '<div class="m">Memuat rekap...</div>';
      var D = R.data; if (!D) return h + '<div class="r"><button class="p" data-kso-rk="load">Tampilkan rekap</button></div>';
      h += '<div class="kt"><table><thead><tr><th>Nama</th><th>出席 Hadir</th><th>無断 Alfa</th><th>病 Sakit</th><th>届 Izin</th><th>%</th><th>Nilai tatap muka</th><th>Latihan</th></tr></thead><tbody>';
      D.siswa.forEach(function (s) {
        var nv = s.nilai.length ? avg(s.nilai.map(function (n) { return +avg(n.sc); })) + ' (' + s.nilai.length + 'x)' : '–';
        h += '<tr><td><b>' + esc(s.nama) + '</b></td><td>' + s.hitung.hadir + '</td><td>' + s.hitung.alfa + '</td><td>' + s.hitung.sakit + '</td><td>' + s.hitung.izin + '</td><td>' + (s.persen == null ? '–' : Math.round(s.persen * 100) + '%') + '</td><td>' + nv + '</td><td>' + (s.akt.mensetsu + s.akt.hirakana + s.akt.kayuki) + '</td></tr>';
      });
      h += '</tbody></table></div><div class="r"><button class="p" data-kso-rk="xlsx">Unduh Excel (.xlsx)</button><button data-kso-rk="pdf">Unduh PDF</button><button data-kso-rk="csv">Unduh CSV</button><button data-kso-rk="load">Muat ulang</button></div>' +
        (R.ok ? '<div class="ok">' + esc(R.ok) + '</div>' : '') + '<div class="m">Rekap berisi kehadiran, penilaian tatap muka, dan aktivitas latihan, dengan keterangan bahasa Indonesia dan Jepang. Untuk Google Sheets: unggah file .xlsx atau .csv ke Google Drive lalu buka dengan Google Sheets.</div>';
      return h;
    }
    function rkUnduh(jenis) {
      var D = SS.rk.data; if (!D) return; SS.rk.msg = '';
      var f = slugFile(D), job;
      try {
        if (jenis === 'xlsx') job = simpanFile(buatXlsx(D), f + '.xlsx', MIME_X, 'Rekap mingguan');
        else if (jenis === 'csv') job = simpanFile(buatCsv(D), f + '.csv', 'text/csv', 'Rekap mingguan');
        else job = simpanFile(buatPdf(D), f + '.pdf', 'application/pdf', 'Rekap mingguan');
      } catch (e) { SS.rk.msg = 'Gagal membuat file di perangkat ini.'; return paint(); }
      job.then(function (t) { SS.rk.msg = ''; SS.rk.ok = t; paint(); });
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
      root.addEventListener('input', function (e) {
        var t = e.target; if (!t) return; if (t.id === 'kso-note') SS.note = t.value;
        var kid = t.getAttribute && t.getAttribute('data-hd-ket'); if (kid) { (SS.hd.m[kid] = SS.hd.m[kid] || { st: 'izin' }).ket = t.value; SS.hd.ok = false; }
      });
      root.addEventListener('change', function (e) { var t = e.target; if (t && (t.id === 'kso-nama' || t.id === 'kso-oleh')) { SS.nama = t.value; wr('kayuki-sync-sn', SS.nama); }
        if (!t || !t.getAttribute) return;
        if (t.id === 'kso-tgl' && t.value) { SS.hd.tgl = t.value; return hdMuat(); }
        if (t.id === 'kso-minggu' && t.value) { SS.rk.mulai = senin(t.value); SS.rk.data = null; return rkMuat(); }
        var b1 = t.getAttribute('data-hd-bukti'); if (b1) { SS.hd.m[b1].bukti = t.value; SS.hd.ok = false; return paint(); }
        var b2 = t.getAttribute('data-hd-ttd'); if (b2) { SS.hd.m[b2].bukti = t.checked ? 'berkas_ttd' : ''; SS.hd.ok = false; }
      });
      root.addEventListener('click', function (e) {
        var t = e.target; if (!t || !t.closest) return;
        var row = t.closest('[data-kso-id]'); if (row) return open(row.getAttribute('data-kso-id'));
        var ap = t.closest('[data-kso-app]'); if (ap) { SS.app = ap.getAttribute('data-kso-app'); SS.sc = null; return paint(); }
        var sc = t.closest('[data-kso-sc]'); if (sc) { var p = sc.getAttribute('data-kso-sc').split(':'); SS.sc[+p[0]] = +p[1]; return paint(); }
        var tb = t.closest('[data-kso-tab]'); if (tb) { SS.tab = tb.getAttribute('data-kso-tab'); SS.err = ''; if (SS.tab === 'hadir') return hdMuat(); if (SS.tab === 'rekap' && !SS.rk.data) return rkMuat(); return paint(); }
        var hb = t.closest('[data-kso-hd]'); if (hb) { var q = hb.getAttribute('data-kso-hd').split(':'), cur = SS.hd.m[q[0]] || {}; SS.hd.m[q[0]] = cur.st === q[1] ? {} : { st: q[1], bukti: '', ket: cur.ket && q[1] === 'izin' ? cur.ket : '' }; SS.hd.ok = false; SS.hd.msg = ''; return paint(); }
        var rk = t.closest('[data-kso-rk]'); if (rk) {
          var ra = rk.getAttribute('data-kso-rk');
          if (ra === 'prev' || ra === 'next' || ra === 'now') { SS.rk.mulai = ra === 'now' ? senin(hariIni()) : addHari(SS.rk.mulai, ra === 'prev' ? -7 : 7); SS.rk.data = null; return rkMuat(); }
          if (ra === 'load') return rkMuat();
          return rkUnduh(ra);
        }
        var b = t.closest('[data-kso]'); if (!b) return; var a = b.getAttribute('data-kso');
        if (a === 'hd-semua') { (SS.rows || []).forEach(function (r) { if (!(SS.hd.m[r.id] && SS.hd.m[r.id].st)) SS.hd.m[r.id] = { st: 'hadir', bukti: '', ket: '' }; }); SS.hd.ok = false; return paint(); }
        if (a === 'hd-simpan') return hdSimpan();
        if (a === 'login') {
          var k = (root.querySelector('#kso-kode') || {}).value, key = (root.querySelector('#kso-key') || {}).value;
          SS.nama = (root.querySelector('#kso-nama') || {}).value || ''; wr('kayuki-sync-sn', SS.nama);
          if (!k || !key) { SS.err = 'Isi kode kelas dan kunci sensei.'; return paint(); }
          if (!SS.nama) { SS.err = 'Pilih nama sensei yang memeriksa.'; return paint(); }
          sensei.simpanKunci(k, key); SS.rows = null; SS.err = '';
          return sensei.rekap().then(function (r) { SS.rows = r; paint(); }).catch(function (er) { sensei.lupa(); SS.err = er.message; paint(); });
        }
        if (a === 'logout') { sensei.lupa(); SS.rows = null; SS.sel = null; SS.det = null; SS.err = ''; SS.tab = 'siswa'; SS.rk.data = null; return paint(); }
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

  /* ---------- absensi harian & rekap mingguan (Indonesia + Jepang) ---------- */
  var HARI_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'], HARI_JP = ['日', '月', '火', '水', '木', '金', '土'];
  var HARI_PENUH = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var ST = {
    hadir: { id: 'Hadir', jp: '出席', k: '○', bg: '#d7f2e3', x: 6 },
    alfa: { id: 'Tanpa keterangan / Alfa', jp: '無断欠席', k: '×', bg: '#f9d6d2', x: 7 },
    sakit: { id: 'Sakit', jp: '病欠', k: '病', bg: '#fcebc2', x: 8 },
    izin: { id: 'Izin', jp: '届出欠席', k: '届', bg: '#d6e4fb', x: 9 }
  };
  var BUKTI = {
    asrama: { id: 'dicek sensei di asrama', jp: '寮にて確認済み' },
    surat_dokter: { id: 'ada surat dokter (di rumah)', jp: '診断書あり' },
    berkas_ttd: { id: 'berkas izin ditandatangani sensei kelas', jp: '届出書に担任署名済み' }
  };
  var RUBRIK_JP = {
    mensetsu: ['声・発音', '目線・表情', '姿勢・お辞儀', '回答内容', '文法・敬語'],
    kayuki: ['語彙', '文法', '漢字', '読解', '試験準備度'],
    hirakana: ['文字認識', '読む速さ', '正確さ', '練習の継続']
  };
  var NAMA_APP_JP = { mensetsu: '面接', kayuki: '日本語練習', hirakana: 'ひらがな・カタカナ' };
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseYmd(s) { var p = String(s).slice(0, 10).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addHari(s, n) { var d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function senin(s) { var d = parseYmd(s), w = d.getDay(); d.setDate(d.getDate() - ((w + 6) % 7)); return ymd(d); }
  function hariIni() { return ymd(new Date()); }
  function tglPendek(s) { return +s.slice(8, 10) + '/' + +s.slice(5, 7); }
  function tglPanjang(s) { try { return parseYmd(s).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return s; } }
  function hariLabel(s) { return HARI_PENUH[parseYmd(s).getDay()] + ', ' + tglPanjang(s); }
  function pctOf(d) {
    d = d || {};
    if (d.skor != null && d.total) return d.skor / d.total * 100;
    if (d.h != null && d.n) return d.h / d.n * 100;
    if (d.pct != null) return +d.pct;
    return null;
  }

  /* susun data rekap satu minggu */
  function susunRekap(per, hd, dari) {
    var hari = []; for (var i = 0; i < 7; i++) hari.push(addHari(dari, i));
    var by = {}; (hd || []).forEach(function (r) { (by[r.siswa] = by[r.siswa] || {})[String(r.tanggal).slice(0, 10)] = r; });
    var out = { kelas: per.kelas || '', dari: dari, sampai: hari[6], hari: hari, siswa: [] };
    (per.siswa || []).forEach(function (s) {
      var m = by[s.id] || {}, c = { hadir: 0, alfa: 0, sakit: 0, izin: 0 }, ket = [];
      hari.forEach(function (h) {
        var r = m[h]; if (!r || !c.hasOwnProperty(r.st)) return; c[r.st]++;
        if (r.st === 'sakit') ket.push(tglPendek(h) + ' Sakit 病欠: ' + (BUKTI[r.bukti] ? BUKTI[r.bukti].id + ' / ' + BUKTI[r.bukti].jp : '-'));
        if (r.st === 'izin') ket.push(tglPendek(h) + ' Izin 届出欠席: ' + (r.ket || '-') + (BUKTI[r.bukti] ? ' (' + BUKTI[r.bukti].id + ' / ' + BUKTI[r.bukti].jp + ')' : ''));
        if (r.st === 'alfa') ket.push(tglPendek(h) + ' Alfa 無断欠席: tanpa keterangan');
      });
      var tc = c.hadir + c.alfa + c.sakit + c.izin;
      var akt = { mensetsu: 0, kayuki: 0, hirakana: 0 }, ps = [];
      (s.hasil || []).forEach(function (h) { if (akt.hasOwnProperty(h.app)) akt[h.app]++; var p = pctOf(h.data); if (p != null) ps.push(p); });
      out.siswa.push({
        id: s.id, nama: s.nama, hari: m, hitung: c, tercatat: tc, persen: tc ? c.hadir / tc : null, ket: ket,
        nilai: (s.nilai || []).map(function (n) { return { app: n.app, sc: n.sc || [], catatan: n.catatan || '', oleh: n.oleh || '', tgl: ymd(new Date(n.waktu)) }; }),
        akt: akt, rata: ps.length ? Math.round(ps.reduce(function (a, b) { return a + b; }, 0) / ps.length) : null
      });
    });
    return out;
  }
  function rincian(n, jp) {
    var rub = RUBRIK[n.app] || [], rj = RUBRIK_JP[n.app] || [];
    return n.sc.map(function (v, i) { return (rub[i] || ('Aspek ' + (i + 1))) + (jp && rj[i] ? ' ' + rj[i] : '') + ' ' + v; }).join(' · ');
  }
  function periodeTeks(R) { return tglPanjang(R.dari) + ' – ' + tglPanjang(R.sampai); }
  function slugFile(R) { return 'Rekap-Mingguan-' + String(sk() ? sk().kode : 'kelas') + '-' + R.dari.replace(/-/g, ''); }

  /* ---- penulis .xlsx tanpa pustaka (zip tanpa kompresi) ---- */
  var CRCT = null;
  function crc32(b) {
    if (!CRCT) { CRCT = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRCT[n] = c >>> 0; } }
    var x = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) x = CRCT[(x ^ b[i]) & 255] ^ (x >>> 8);
    return (x ^ 0xFFFFFFFF) >>> 0;
  }
  function zipBytes(files) {
    var enc = new TextEncoder(), parts = [], cd = [], off = 0;
    function u16(v) { return [v & 255, (v >> 8) & 255]; }
    function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    function add(a) { var u = a instanceof Uint8Array ? a : new Uint8Array(a); parts.push(u); off += u.length; }
    files.forEach(function (f) {
      var nm = enc.encode(f.n), crc = crc32(f.b), sz = f.b.length, start = off;
      add([0x50, 0x4b, 3, 4].concat(u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(sz), u32(sz), u16(nm.length), u16(0)));
      add(nm); add(f.b);
      cd.push([0x50, 0x4b, 1, 2].concat(u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(sz), u32(sz), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(start)).concat(Array.prototype.slice.call(nm)));
    });
    var cdStart = off, cdLen = 0; cd.forEach(function (a) { add(a); cdLen += a.length; });
    add([0x50, 0x4b, 5, 6].concat(u16(0), u16(0), u16(files.length), u16(files.length), u32(cdLen), u32(cdStart), u16(0)));
    var out = new Uint8Array(off), o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  function colL(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function xe(s) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* gaya sel: 1 judul, 2 catatan kecil, 3 kepala tabel, 4 teks, 5 tengah, 6-9 status, 10 persen, 11 tebal */
  function sheetXML(sh) {
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"' + (sh.freeze ? '><pane xSplit="' + sh.freeze[0] + '" ySplit="' + sh.freeze[1] + '" topLeftCell="' + colL(sh.freeze[0]) + (sh.freeze[1] + 1) + '" activePane="bottomRight" state="frozen"/></sheetView>' : '/>') + '</sheetViews><sheetFormatPr defaultRowHeight="16"/>';
    x += '<cols>' + sh.w.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>';
    sh.rows.forEach(function (row, r) {
      var ht = sh.ht && sh.ht[r];
      x += '<row r="' + (r + 1) + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>';
      row.forEach(function (cell, ci) {
        if (cell == null || cell === '') return;
        var v = cell, s = 4; if (typeof cell === 'object') { v = cell.v; s = cell.s; }
        var ref = colL(ci) + (r + 1);
        if (typeof v === 'number') x += '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
        else x += '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
      });
      x += '</row>';
    });
    x += '</sheetData>';
    if (sh.merges && sh.merges.length) x += '<mergeCells count="' + sh.merges.length + '">' + sh.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';
    return x + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }
  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><color rgb="FF0E1C48"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF5B6B8C"/><name val="Calibri"/></font></fonts>' +
    '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    ['FF1D63D8', 'FFD7F2E3', 'FFF9D6D2', 'FFFCEBC2', 'FFD6E4FB'].map(function (c) { return '<fill><patternFill patternType="solid"><fgColor rgb="' + c + '"/><bgColor indexed="64"/></patternFill></fill>'; }).join('') + '</fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB8C4DE"/></left><right style="thin"><color rgb="FFB8C4DE"/></right><top style="thin"><color rgb="FFB8C4DE"/></top><bottom style="thin"><color rgb="FFB8C4DE"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="12">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    [3, 4, 5, 6].map(function (f) { return '<xf numFmtId="0" fontId="2" fillId="' + f + '" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'; }).join('') +
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function buatXlsx(R) {
    var nh = R.hari.length, H = function (t) { return { v: t, s: 3 }; };
    /* lembar 1: kehadiran */
    var r1 = [], ht = {}, merges = [], lastCol = 2 + nh + 5;
    r1.push([{ v: '週間出欠・成績報告書  /  Rekap Mingguan Kehadiran & Penilaian', s: 1 }]); merges.push('A1:' + colL(lastCol) + '1');
    r1.push([{ v: 'クラス Kelas: ' + R.kelas + ' (' + (sk() ? sk().kode : '') + ')   期間 Periode: ' + periodeTeks(R), s: 2 }]); merges.push('A2:' + colL(lastCol) + '2');
    r1.push([{ v: '作成日 Dibuat: ' + tglPanjang(hariIni()) + '   Kayuki Nihongo Gakkou', s: 2 }]); merges.push('A3:' + colL(lastCol) + '3');
    r1.push([]);
    var hd = [H('No.'), H('氏名\nNama')];
    R.hari.forEach(function (h) { var d = parseYmd(h).getDay(); hd.push(H(HARI_JP[d] + ' ' + HARI_ID[d] + '\n' + tglPendek(h))); });
    ['出席\nHadir', '無断欠席\nAlfa', '病欠\nSakit', '届出欠席\nIzin', '出席率\n% Hadir', '備考\nKeterangan'].forEach(function (t) { hd.push(H(t)); });
    ht[r1.length] = 36; r1.push(hd);
    R.siswa.forEach(function (s, i) {
      var row = [{ v: i + 1, s: 5 }, { v: s.nama, s: 11 }];
      R.hari.forEach(function (h) { var r = s.hari[h]; row.push(r && ST[r.st] ? { v: ST[r.st].k, s: ST[r.st].x } : { v: '-', s: 5 }); });
      row.push({ v: s.hitung.hadir, s: 5 }, { v: s.hitung.alfa, s: 5 }, { v: s.hitung.sakit, s: 5 }, { v: s.hitung.izin, s: 5 });
      row.push(s.persen == null ? { v: '-', s: 5 } : { v: s.persen, s: 10 }); row.push({ v: s.ket.join('\n'), s: 4 });
      r1.push(row);
    });
    r1.push([]);
    r1.push([{ v: '凡例 Keterangan simbol', s: 11 }]); merges.push('A' + r1.length + ':' + colL(lastCol) + r1.length);
    ['hadir', 'alfa', 'sakit', 'izin'].forEach(function (k) { r1.push([{ v: ST[k].k, s: ST[k].x }, { v: ST[k].jp + '  /  ' + ST[k].id, s: 4 }]); merges.push('B' + r1.length + ':' + colL(lastCol) + r1.length); });
    r1.push([{ v: '-', s: 5 }, { v: '未記録 / Belum diabsen', s: 4 }]); merges.push('B' + r1.length + ':' + colL(lastCol) + r1.length);
    r1.push([{ v: '病欠: 寮は確認済み、自宅は診断書あり / Sakit: dicek sensei bila di asrama, surat dokter bila di rumah.  届出欠席: 理由と届出書(担任署名)あり / Izin: ada keterangan keperluan dan berkas izin ditandatangani sensei kelas.', s: 2 }]); merges.push('A' + r1.length + ':' + colL(lastCol) + r1.length);
    r1.push([]); r1.push([{ v: '担当教師 Sensei: ____________________', s: 0 }, null, null, null, null, null, null, null, null, null, { v: '確認 Manajemen: ____________________', s: 0 }]);
    var w1 = [5, 26]; for (var i = 0; i < nh; i++) w1.push(9); w1.push(8, 11, 8, 11, 10, 52);
    /* lembar 2: penilaian */
    var r2 = [[{ v: '成績評価(対面)  /  Penilaian Tatap Muka', s: 1 }], [{ v: 'Periode: ' + periodeTeks(R), s: 2 }], [], [H('日付\nTanggal'), H('氏名\nNama'), H('アプリ\nAplikasi'), H('評価内訳\nRincian skor (1-5)'), H('平均\nRata-rata'), H('備考\nCatatan'), H('担当\nSensei')]];
    var ht2 = {}; ht2[3] = 34; var ada = false;
    R.siswa.forEach(function (s) { s.nilai.forEach(function (n) { ada = true; r2.push([{ v: tglPendek(n.tgl), s: 5 }, { v: s.nama, s: 11 }, { v: (NAMA_APP[n.app] || n.app) + ' ' + (NAMA_APP_JP[n.app] || ''), s: 4 }, { v: rincian(n, true), s: 4 }, { v: +avg(n.sc), s: 5 }, { v: n.catatan, s: 4 }, { v: n.oleh, s: 4 }]); }); });
    if (!ada) r2.push([{ v: '今期の対面評価はありません / Tidak ada penilaian tatap muka pada periode ini.', s: 2 }]);
    /* lembar 3: aktivitas */
    var r3 = [[{ v: '自主学習の活動  /  Aktivitas Latihan Mandiri', s: 1 }], [{ v: 'Periode: ' + periodeTeks(R) + '  (jumlah sesi latihan/tes yang tercatat di aplikasi)', s: 2 }], [], [H('氏名\nNama'), H('面接\nMensetsu'), H('ひらがな\nHiraKana'), H('日本語練習\nKayuki'), H('合計\nTotal'), H('平均点\nRata-rata nilai %')]];
    var ht3 = {}; ht3[3] = 34;
    R.siswa.forEach(function (s) { var t = s.akt.mensetsu + s.akt.hirakana + s.akt.kayuki; r3.push([{ v: s.nama, s: 11 }, { v: s.akt.mensetsu, s: 5 }, { v: s.akt.hirakana, s: 5 }, { v: s.akt.kayuki, s: 5 }, { v: t, s: 5 }, s.rata == null ? { v: '-', s: 5 } : { v: s.rata / 100, s: 10 }]); });
    var sheets = [
      { n: '出欠 Kehadiran', x: sheetXML({ rows: r1, w: w1, ht: ht, merges: merges, freeze: [2, 5] }) },
      { n: '成績 Penilaian', x: sheetXML({ rows: r2, w: [10, 24, 24, 60, 10, 40, 18], ht: ht2, merges: [] }) },
      { n: '学習 Aktivitas', x: sheetXML({ rows: r3, w: [26, 12, 12, 14, 10, 16], ht: ht3, merges: [] }) }
    ];
    var enc = new TextEncoder(), D = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    var files = [
      { n: '[Content_Types].xml', b: enc.encode(D + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
      { n: '_rels/.rels', b: enc.encode(D + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { n: 'xl/workbook.xml', b: enc.encode(D + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map(function (s, i) { return '<sheet name="' + xe(s.n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>') },
      { n: 'xl/_rels/workbook.xml.rels', b: enc.encode(D + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { n: 'xl/styles.xml', b: enc.encode(STYLES) }
    ];
    sheets.forEach(function (s, i) { files.push({ n: 'xl/worksheets/sheet' + (i + 1) + '.xml', b: enc.encode(s.x) }); });
    return zipBytes(files);
  }
  function buatCsv(R) {
    function q(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var rows = [['氏名 Nama'].concat(R.hari.map(function (h) { var d = parseYmd(h).getDay(); return HARI_JP[d] + ' ' + HARI_ID[d] + ' ' + tglPendek(h); }), ['出席 Hadir', '無断欠席 Alfa', '病欠 Sakit', '届出欠席 Izin', '出席率 % Hadir', '備考 Keterangan', '平均点 Rata-rata nilai %', '評価(対面) Penilaian tatap muka'])];
    R.siswa.forEach(function (s) {
      rows.push([s.nama].concat(R.hari.map(function (h) { var r = s.hari[h]; return r && ST[r.st] ? ST[r.st].jp : ''; }),
        [s.hitung.hadir, s.hitung.alfa, s.hitung.sakit, s.hitung.izin, s.persen == null ? '' : Math.round(s.persen * 100) + '%', s.ket.join(' | '), s.rata == null ? '' : s.rata + '%',
          s.nilai.map(function (n) { return tglPendek(n.tgl) + ' ' + (NAMA_APP[n.app] || n.app) + ' ' + avg(n.sc) + '/5' + (n.catatan ? ' (' + n.catatan + ')' : ''); }).join(' | ')]));
    });
    return new TextEncoder().encode('﻿' + rows.map(function (r) { return r.map(q).join(','); }).join('\r\n'));
  }

  /* ---- PDF (halaman A4 mendatar, digambar di canvas supaya aksara Jepang tampil benar) ---- */
  function makePDFland(pages) {
    var enc = new TextEncoder(), chunks = [], off = 0, offs = {}, PW = 841.89, PH = 595.28;
    function put(x) { var b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); off += b.length; }
    function obj(id, body) { offs[id] = off; put(id + ' 0 obj\n' + body + '\nendobj\n'); }
    var n = pages.length; put('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + pages.map(function (_, i) { return (3 + i * 3) + ' 0 R'; }).join(' ') + '] /Count ' + n + ' >>');
    pages.forEach(function (pg, i) {
      var pid = 3 + i * 3, cid = pid + 1, iid = pid + 2, cs = 'q ' + PW + ' 0 0 ' + PH + ' 0 0 cm /Im0 Do Q';
      obj(pid, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Resources << /XObject << /Im0 ' + iid + ' 0 R >> >> /Contents ' + cid + ' 0 R >>');
      obj(cid, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
      offs[iid] = off;
      put(iid + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + pg.w + ' /Height ' + pg.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + pg.bytes.length + ' >>\nstream\n');
      put(pg.bytes); put('\nendstream\nendobj\n');
    });
    var total = 2 + n * 3, xo = off, x = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (var id = 1; id <= total; id++) x += String(offs[id]).padStart(10, '0') + ' 00000 n \n';
    put(x + 'trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xo + '\n%%EOF\n');
    var out = new Uint8Array(off), o = 0; chunks.forEach(function (b) { out.set(b, o); o += b.length; });
    return out;
  }
  function buatPdf(R) {
    var W = 1754, HT = 1240, M = 64, FONT = "'Noto Sans JP','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo','Noto Sans CJK JP',sans-serif";
    var cvs = [], cv, c, y;
    function page() { cv = document.createElement('canvas'); cv.width = W; cv.height = HT; c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, W, HT); cvs.push(cv); y = M; }
    function font(sz, w) { c.font = (w || 500) + ' ' + sz + 'px ' + FONT; }
    function wrap(t, w, sz, wt) {
      font(sz, wt); var out = [];
      String(t == null ? '' : t).split('\n').forEach(function (par) {
        var line = '';
        for (var i = 0; i < par.length; i++) {
          var t2 = line + par[i];
          if (c.measureText(t2).width > w && line) {
            var sp = line.lastIndexOf(' '), lat = /[A-Za-z0-9]/.test(par[i]) && sp > 0;
            if (lat) { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + par[i]; } else { out.push(line); line = par[i]; }
          } else line = t2;
        }
        out.push(line);
      });
      return out;
    }
    function need(h) { if (y + h > HT - 80) { page(); return true; } return false; }
    function heading(t, sz) { need(sz + 30); font(sz, 800); c.fillStyle = '#0e1c48'; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText(t, M, y + sz); y += sz + 18; }
    function table(cols, rows, o) {
      o = o || {}; var fs = o.fs || 21, lh = fs + 8, pad = 9;
      function drawHead() {
        var hh = 0, hl = cols.map(function (cl) { var l = wrap(cl.h, cl.w - 2 * pad, fs - 1, 800); hh = Math.max(hh, l.length); return l; });
        var h = hh * lh + 2 * pad; need(h + 60); var x = M;
        cols.forEach(function (cl, i) { c.fillStyle = '#1d63d8'; c.fillRect(x, y, cl.w, h); c.strokeStyle = '#b8c4de'; c.strokeRect(x, y, cl.w, h); font(fs - 1, 800); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; hl[i].forEach(function (ln, k) { c.fillText(ln, x + cl.w / 2, y + pad + (k + 1) * lh - 7); }); x += cl.w; });
        y += h;
      }
      drawHead();
      rows.forEach(function (row) {
        var mx = 1, ls = row.map(function (cell, i) { var l = wrap(cell.t, cols[i].w - 2 * pad, fs, cell.b ? 800 : 500); mx = Math.max(mx, l.length); return l; });
        var h = mx * lh + 2 * pad;
        if (y + h > HT - 80) { page(); drawHead(); }
        var x = M;
        row.forEach(function (cell, i) {
          c.fillStyle = cell.bg || '#fff'; c.fillRect(x, y, cols[i].w, h); c.strokeStyle = '#b8c4de'; c.strokeRect(x, y, cols[i].w, h);
          font(fs, cell.b ? 800 : 500); c.fillStyle = cell.fg || '#0e1c48'; c.textBaseline = 'alphabetic';
          var al = cols[i].al === 'c' ? 'center' : 'left'; c.textAlign = al;
          ls[i].forEach(function (ln, k) { c.fillText(ln, al === 'center' ? x + cols[i].w / 2 : x + pad, y + pad + (k + 1) * lh - 7); });
          x += cols[i].w;
        });
        y += h;
      });
      y += 22;
    }
    page();
    /* judul */
    c.fillStyle = '#1d63d8'; c.fillRect(0, 0, W, 16);
    font(44, 800); c.fillStyle = '#0e1c48'; c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.fillText('週間出欠・成績報告書', M, y + 48);
    font(26, 600); c.fillStyle = '#4b5b88'; c.fillText('Rekap Mingguan Kehadiran & Penilaian · Kayuki Nihongo Gakkou', M, y + 88); y += 112;
    font(24, 600); c.fillStyle = '#0e1c48'; c.fillText('クラス Kelas: ' + R.kelas + (sk() ? ' (' + sk().kode + ')' : '') + '    期間 Periode: ' + periodeTeks(R) + '    作成日 Dibuat: ' + tglPanjang(hariIni()), M, y + 24); y += 52;
    /* kehadiran */
    heading('出欠表  Rekap Kehadiran', 30);
    var dw = 96, cols = [{ h: 'No.', w: 56, al: 'c' }, { h: '氏名 Nama', w: 300 }];
    R.hari.forEach(function (h) { var d = parseYmd(h).getDay(); cols.push({ h: HARI_JP[d] + ' ' + HARI_ID[d] + '\n' + tglPendek(h), w: dw, al: 'c' }); });
    cols.push({ h: '出席\nHadir', w: 100, al: 'c' }, { h: '無断欠席\nAlfa', w: 120, al: 'c' }, { h: '病欠\nSakit', w: 100, al: 'c' }, { h: '届出欠席\nIzin', w: 120, al: 'c' }, { h: '出席率\n% Hadir', w: W - 2 * M - (56 + 300 + 7 * dw + 440), al: 'c' });
    var rows = R.siswa.map(function (s, i) {
      var r = [{ t: String(i + 1) }, { t: s.nama, b: true }];
      R.hari.forEach(function (h) { var x = s.hari[h]; r.push(x && ST[x.st] ? { t: ST[x.st].k, bg: ST[x.st].bg, b: true } : { t: '-', fg: '#8a98ab' }); });
      r.push({ t: String(s.hitung.hadir) }, { t: String(s.hitung.alfa) }, { t: String(s.hitung.sakit) }, { t: String(s.hitung.izin) }, { t: s.persen == null ? '-' : Math.round(s.persen * 100) + '%', b: true });
      return r;
    });
    table(cols, rows);
    need(150); font(21, 600); c.fillStyle = '#4b5b88'; c.textAlign = 'left';
    var lg = ['○ 出席 Hadir', '× 無断欠席 Tanpa keterangan / Alfa', '病 病欠 Sakit', '届 届出欠席 Izin', '- 未記録 Belum diabsen'], lx = M;
    lg.forEach(function (t) { c.fillText(t, lx, y + 20); lx += c.measureText(t).width + 40; }); y += 34;
    font(19, 500); c.fillText('病欠: 寮は確認済み・自宅は診断書あり / Sakit: dicek sensei bila di asrama, surat dokter bila di rumah.', M, y + 18); y += 28;
    c.fillText('届出欠席: 理由と届出書(担任署名)あり / Izin: ada keperluan dan berkas izin ditandatangani sensei kelas.', M, y + 18); y += 44;
    var ada = R.siswa.filter(function (s) { return s.ket.length; });
    if (ada.length) {
      heading('備考  Keterangan ketidakhadiran', 28);
      table([{ h: '氏名 Nama', w: 380 }, { h: '内容 Keterangan', w: W - 2 * M - 380 }], ada.map(function (s) { return [{ t: s.nama, b: true }, { t: s.ket.join('\n') }]; }));
    }
    /* penilaian */
    var nr = []; R.siswa.forEach(function (s) { s.nilai.forEach(function (n) { nr.push([{ t: tglPendek(n.tgl) }, { t: s.nama, b: true }, { t: (NAMA_APP[n.app] || n.app) + '\n' + (NAMA_APP_JP[n.app] || '') }, { t: rincian(n, true) }, { t: avg(n.sc), b: true }, { t: n.catatan }, { t: n.oleh }]); }); });
    need(200); heading('成績評価(対面)  Penilaian Tatap Muka', 30);
    if (nr.length) table([{ h: '日付\nTanggal', w: 100, al: 'c' }, { h: '氏名 Nama', w: 260 }, { h: 'アプリ Aplikasi', w: 200 }, { h: '評価内訳 Rincian skor (1-5)', w: 540 }, { h: '平均\nRata²', w: 90, al: 'c' }, { h: '備考 Catatan', w: W - 2 * M - 1190 - 200 }, { h: '担当 Sensei', w: 200 }], nr, { fs: 19 });
    else { font(22, 500); c.fillStyle = '#4b5b88'; c.textAlign = 'left'; c.fillText('今期の対面評価はありません / Tidak ada penilaian tatap muka pada periode ini.', M, y + 22); y += 50; }
    /* aktivitas */
    need(220); heading('学習活動  Aktivitas latihan mandiri', 30);
    table([{ h: '氏名 Nama', w: 380 }, { h: '面接 Mensetsu', w: 200, al: 'c' }, { h: 'ひらがな HiraKana', w: 220, al: 'c' }, { h: '日本語 Kayuki', w: 200, al: 'c' }, { h: '合計 Total', w: 160, al: 'c' }, { h: '平均点 Rata-rata nilai', w: W - 2 * M - 1160, al: 'c' }],
      R.siswa.map(function (s) { return [{ t: s.nama, b: true }, { t: String(s.akt.mensetsu) }, { t: String(s.akt.hirakana) }, { t: String(s.akt.kayuki) }, { t: String(s.akt.mensetsu + s.akt.hirakana + s.akt.kayuki) }, { t: s.rata == null ? '-' : s.rata + '%', b: true }]; }));
    /* tanda tangan */
    need(190); y += 20; c.strokeStyle = '#8a98ab'; c.lineWidth = 2; font(22, 700); c.fillStyle = '#0e1c48'; c.textAlign = 'left';
    c.fillText('担当教師 Sensei', M, y + 22); c.fillText('確認 Manajemen', M + 700, y + 22);
    c.beginPath(); c.moveTo(M, y + 120); c.lineTo(M + 520, y + 120); c.moveTo(M + 700, y + 120); c.lineTo(M + 1220, y + 120); c.stroke(); c.lineWidth = 1;
    var pages = [];
    cvs.forEach(function (p, i) {
      var g = p.getContext('2d'); g.font = '500 19px ' + FONT; g.fillStyle = '#8a98ab'; g.textAlign = 'center'; g.fillText('Kayuki Nihongo Gakkou · ' + (i + 1) + ' / ' + cvs.length, W / 2, HT - 36);
      var b = atob(p.toDataURL('image/jpeg', .9).split(',')[1]), u = new Uint8Array(b.length); for (var k = 0; k < b.length; k++) u[k] = b.charCodeAt(k);
      pages.push({ w: W, h: HT, bytes: u });
    });
    return makePDFland(pages);
  }
  function simpanFile(bytes, fname, mime, judul) {
    var blob = new Blob([bytes], { type: mime }), file = null;
    try { file = new File([blob], fname, { type: mime }); } catch (e) {}
    var touch = window.matchMedia && matchMedia('(pointer:coarse)').matches;
    function unduh() {
      var u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000); return Promise.resolve('Tersimpan: ' + fname);
    }
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: judul }).then(function () { return 'Siap dibagikan.'; }, function (e) { return e && e.name === 'AbortError' ? '' : unduh(); });
    }
    return unduh();
  }
  var MIME_X = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    mountPanel: mountPanel, mountSensei: mountSensei, daftarSensei: DAFTAR_SENSEI, sensei: sensei, versi: 6
  };
})();
