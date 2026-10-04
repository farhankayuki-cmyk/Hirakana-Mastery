# HiraKana Mastery Kayuki: panduan pasang (versi cepat)

**Kenapa belum bisa dipasang di HP?** Karena file dibuka langsung dari HP atau dari WhatsApp/zip. Agar muncul tombol pasang dan bisa offline, folder ini harus ditaruh di internet dulu (alamat `https://...`). Caranya 5 menit, gratis:

## Cara tercepat: Netlify Drop
1. Ekstrak zip ini di komputer sampai jadi **folder** `hirakana-mastery-pwa` (jangan seret file zip-nya).
2. Buka **app.netlify.com/drop** di browser komputer, masuk/daftar dengan akun Google.
3. **Seret folder `hirakana-mastery-pwa`** ke kotak yang tersedia. Tunggu beberapa detik sampai muncul alamat seperti `https://nama-acak.netlify.app`.
4. (Opsional) Di *Site configuration* lalu *Change site name*, ganti jadi nama yang enak, misalnya `hirakana-kayuki`.
5. Buka alamat itu di **Chrome (Android)** atau **Safari (iPhone)**, lalu ketuk **📲 Pasang aplikasi**. Selesai.

Alternatif sama gampangnya: **Cloudflare Pages** (dash.cloudflare.com, menu Workers & Pages, Create, Pages, *Upload assets*, seret folder yang sama).

---


## Isi folder
- `index.html`: aplikasinya (semua fitur ada di sini)
- `manifest.webmanifest`: data supaya bisa dipasang seperti aplikasi
- `sw.js`: bikin aplikasi tetap jalan tanpa internet
- `icons/`: ikon aplikasi (dibuat dari logo Kayuki)

## 1. Taruh di hosting (wajib HTTPS)
Fitur pasang dan offline **tidak jalan kalau file dibuka langsung dari HP/PC** (alamat `file://`). Foldernya harus ada di alamat web `https://`. Pilihan gratis yang gampang:
- **Netlify** atau **Cloudflare Pages**: seret-lepas (drag and drop) folder ini, selesai.
- **GitHub Pages**: upload isi folder ke repo, aktifkan Pages.
- **Portal Kayuki sendiri**: taruh folder ini di hosting portal, misalnya `portal.domain/hirakana/`.

Kalau mau tersambung ke portal, taruh `kayuki-config.js` dan `kayuki-sync.js` **di folder yang sama** dengan `index.html`. Service worker otomatis ikut menyimpannya untuk offline.

## 2. Cara siswa memasang
- **Android (Chrome)**: buka alamatnya, ketuk tombol **📲 Pasang aplikasi** di bagian atas, atau menu ⋮ lalu *Instal aplikasi*.
- **iPhone/iPad (Safari)**: ketuk **📲 Pasang aplikasi** lalu ikuti petunjuknya, atau Bagikan lalu *Tambah ke Layar Utama*. Harus Safari, bukan browser di dalam aplikasi lain.
- **Komputer (Chrome/Edge)**: klik ikon pasang di sebelah kanan kolom alamat, atau tombol **📲 Pasang aplikasi**.
- Kalau alamatnya dibuka dari link di dalam WhatsApp/Instagram, minta siswa pilih *Buka di browser* dulu.

Buka aplikasinya satu kali dengan internet. Setelah muncul tulisan "Siap dipakai tanpa internet", aplikasi bisa dipakai di mana saja tanpa kuota. Hasil ujian yang belum terkirim ke portal disimpan dulu, lalu dikirim otomatis saat internet nyala lagi.

## 3. Cara memperbarui aplikasi
1. Ganti file `index.html` di hosting.
2. Supaya semua perangkat langsung ambil versi baru, ubah angka di `sw.js`: `const VERSI = 'hirakana-v1'` menjadi `'hirakana-v2'`, dan seterusnya.

Tanpa mengganti angka itu, perangkat tetap mengambil versi baru diam-diam dan tampil pada pembukaan berikutnya.

## 4. Pengaturan yang bisa diubah (di bagian atas script `index.html`)
| Nama | Isi sekarang | Fungsi |
|---|---|---|
| `KEN_N` | 20 | jumlah soal Ujian Kenaikan |
| `KEN_ALL_N` | 30 | jumlah soal Ujian Akhir Hiragana |
| `LANCAR_PCT` | 90 | nilai minimal lencana Lancar (%) |
| `LANCAR_DTK` | 8 | rata-rata maksimal detik per soal untuk lencana Lancar |
| `GURU_KODE` | KAYUKI2026 | kode **Mode guru** (membuka semua rumpun) |
| `PASS` | 70 | batas lulus |

**Ganti `GURU_KODE` sebelum dibagikan ke siswa.** Kode ini tertulis di file, jadi cukup untuk kelas, bukan pengamanan ketat.

## 5. Yang perlu diketahui
- Semua data siswa (riwayat, kunci rumpun, huruf lemah) tersimpan **di perangkat masing-masing**. Ganti HP atau hapus data browser berarti mulai dari awal, kecuali sudah tersinkron ke portal.
- Safari di iPhone bisa menghapus data situs yang lama tidak dibuka. Aplikasi yang sudah dipasang di layar utama lebih aman dari itu.

## Tab baru: 🔤 Huruf (peta huruf)

- Tabel huruf berwarna sesuai penguasaan (belum / baru kenal / hampir / hafal), dihitung dari semua latihan dan ujian di perangkat ini.
- Ketuk huruf: cara ingat (jembatan keledai), suara, huruf yang sering tertukar, animasi urutan menulis, dan papan latihan menulis (tanpa penilaian, tidak diujikan).
- Ketuk nama baris (あ行, か行, ...) untuk memilih huruf yang mau dilatih. Rumpun 2 dan 3 terbuka mengikuti aturan Ujian Kenaikan.
- Empat cara latihan: Lihat huruf, Lihat bacaan, Dengar suara, Huruf mirip.
- Katakana: bentuk, cara ingat, suara, dan urutan tulis sudah bisa dilihat. Latihan dan ujian katakana menyusul.
- Data urutan goresan: KanjiVG, hak cipta (C) Ulrich Apel, lisensi CC BY-SA 3.0 (https://kanjivg.tagaini.net). Data goresan di dalam `index.html` tunduk pada lisensi ini.
