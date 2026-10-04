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
    s.textContent = '.ks{display:flex;flex-direction:column;gap:8px;font-size:14px}.ks input{font:inherit;padding:9px 11px;border:1.5px solid var(--line,#d6e1f7);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#0e1c48);min-width:0;flex:1}.ks .r{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ks button{font:inherit;font-weight:700;padding:9px 14px;border-radius:10px;border:1.5px solid var(--line,#d6e1f7);background:var(--surface,#fff);color:var(--ink,#0e1c48);cursor:pointer}.ks button.p{background:#1d63d8;border-color:#1d63d8;color:#fff}.ks .m{color:var(--ink-2,#4b5b88);font-size:12.5px}.ks .e{color:#c0392b;font-size:12.5px}.ks .ok{color:#1f9d6b;font-weight:700}';
    document.head.appendChild(s);
  }
  function fmtT(iso) { try { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  var panelPaint = null;
  function mountPanel(el, o) {
    if (!el) return; css();
    var msg = '';
    function paint() {
      var s = state();
      if (s.gabung) {
        el.innerHTML = '<div class="ks"><div><span class="ok">Terhubung</span> ke kelas <b>' + esc(s.kelas) + '</b> sebagai <b>' + esc(s.nama) + '</b></div>' +
          '<div class="m">' + (s.antre ? s.antre + ' data menunggu dikirim' : 'Semua data sudah terkirim') + (s.terakhir ? ' · terakhir ' + fmtT(s.terakhir) : '') + (s.online ? '' : ' · sedang offline') + '</div>' +
          (s.galat ? '<div class="e">' + esc(s.galat) + '</div>' : '') +
          '<div class="r"><button data-ks="sync" class="p">Sinkronkan sekarang</button><button data-ks="out">Keluar dari kelas</button></div></div>';
      } else {
        el.innerHTML = '<div class="ks"><div class="m">Gabung kelas supaya sensei bisa melihat progresmu dan memberi catatan. Tanpa gabung, progres tetap tersimpan di HP ini.</div>' +
          '<div class="r"><input id="ks-kode" placeholder="Kode kelas" autocapitalize="characters" autocomplete="off"><input id="ks-nama" placeholder="Nama lengkap" autocomplete="name" value="' + esc(o && o.nama) + '"></div>' +
          (msg ? '<div class="e">' + esc(msg) + '</div>' : '') +
          '<div class="r"><button data-ks="join" class="p">Gabung kelas</button></div></div>';
      }
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ks]'); if (!b) return;
      var a = b.getAttribute('data-ks');
      if (a === 'sync') { b.textContent = 'Mengirim...'; flush().then(paint); }
      if (a === 'out') { if (confirm('Keluar dari kelas? Data di HP ini tetap ada.')) { keluar(); msg = ''; paint(); } }
      if (a === 'join') {
        var k = el.querySelector('#ks-kode').value, n = el.querySelector('#ks-nama').value;
        b.disabled = true; b.textContent = 'Menghubungkan...';
        gabung(k, n).then(function () { msg = ''; paint(); }).catch(function (er) { msg = er.message; paint(); });
      }
    });
    var i = listeners.indexOf(panelPaint); if (i >= 0) listeners.splice(i, 1);
    panelPaint = paint; listeners.push(paint); paint();
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
    mountPanel: mountPanel, sensei: sensei, versi: 2
  };
})();
