# T-Drive

Drive ala Google Drive yang berjalan **100% di browser**, dengan **Telegram sebagai penyimpanan**. Tanpa backend, tanpa framework (vanilla JS + Vite).

- Login cukup scan kode QR dari aplikasi Telegram (atau pakai nomor telepon). Koneksi MTProto lewat WebSocket (GramJS).
- Semua file **dienkripsi di browser** (AES-256-GCM) sebelum diunggah. Telegram hanya melihat blob acak bernama `xxxx.bin`.
- Opsional: **Upload file terbuka** (menu Baru) menyimpan file apa adanya dengan nama dan tipe asli, jadi bisa dilihat langsung di Telegram. Tidak terenkripsi, jadi siapa pun dengan akses channel bisa membacanya. Default tetap terenkripsi. Bisa diubah bolak-balik lewat klik kanan › "Ubah ke terbuka/tertutup" (file diunggah ulang).
- **Berbagi lewat link:** klik kanan › Bagikan. Dibuat channel Telegram khusus berisi salinan (forward, tanpa unggah ulang) plus manifes terenkripsi; kunci ada di bagian `#` link. Penerima login Telegram, lalu bisa melihat, mengunduh, atau menyimpan ke drive-nya. Cabut di menu **Dibagikan** (channel dihapus). Tidak ada izin "hanya lihat".
- **Impor dari Telegram:** file yang kamu kirim langsung ke channel "T-Drive Storage" lewat aplikasi Telegram (sebagai file, bukan foto terkompresi) otomatis muncul di folder **Dari Telegram** sebagai file terbuka, dan bisa dipindah atau diganti nama.
- **Passphrase:** bisa diubah (menu avatar › Ubah passphrase; kunci file tidak berubah, jadi file tetap terbuka). Passphrase diingat 1 jam di browser ini supaya tidak ditanya tiap muat ulang; Kunci atau Keluar langsung melupakannya. Kalau lupa: "Lupa passphrase?" membuat drive kosong baru (file terenkripsi lama tidak bisa dipulihkan).
- Daftar folder/file (index) juga terenkripsi, disimpan sebagai pesan yang di-pin di channel privat **"T-Drive Storage"**.
- File besar dipecah otomatis (≈1,86 GB per pesan), jadi ukuran file tidak dibatasi 2 GB.
- Streaming video/audio dengan seek, pratinjau gambar/PDF/teks, unduhan langsung ke disk lewat Service Worker.
- Folder, upload file/folder, drag & drop, pindah (termasuk drag ke folder), ganti nama, bintang, sampah + pulihkan, hapus permanen, pencarian, tampilan petak/daftar, mode gelap, responsif.
- Bisa dipakai di beberapa perangkat. Perubahan dari perangkat lain terdeteksi otomatis dan tidak saling menimpa.

## Menjalankan

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + end-to-end (fake Telegram) + cek serialisasi TL
npm run build      # hasil statis di dist/
```

Untuk mencoba UI tanpa akun Telegram, jalankan `npm run dev` lalu buka `/test/harness.html`. Halaman itu memakai UI asli dengan Telegram tiruan di memori.

Butuh **API ID & API hash** dari <https://my.telegram.org> › *API development tools* (sekali saja, oleh pemilik deploy). Ada dua cara mengisinya:
- Diisi user saat pertama membuka aplikasi (disimpan di localStorage), atau
- Ditanam saat build lewat `VITE_TG_API_ID` / `VITE_TG_API_HASH` (lihat `.env.example`). **Disarankan**: user langsung melihat layar login QR tanpa isian apa pun.

## Deploy (GitHub Pages)

Workflow `.github/workflows/deploy.yml` sudah tersedia. Push ke `main`, lalu aktifkan *Settings › Pages › Source: GitHub Actions*. Variabel `VITE_TG_API_ID`/`VITE_TG_API_HASH` bisa diisi di *Settings › Secrets and variables › Actions › Variables* (opsional).

Hosting statis lain (Cloudflare Pages, Netlify, Vercel) juga bisa: upload isi `dist/`. **Wajib HTTPS** (WebCrypto & Service Worker).

## Cara kerja

```
File ──► potong per 1.048.560 B ──► AES-GCM (kunci acak per file, IV = nonce‖index)
     ──► blok cipher tepat 1 MiB ──► upload.saveBigFilePart (2 × 512 KB)
     ──► messages.sendMedia ke channel privat (1 pesan per ≤1900 blok)

Index { folder, file, kunci file, id pesan } ──► gzip ──► AES-GCM(passphrase, PBKDF2 600k)
     ──► dokumen "t-drive-index.bin" yang di-pin di channel
```

Karena tiap blok cipher tepat 1 MiB, satu `upload.getFile` (offset kelipatan 1 MiB) = satu blok. Itu yang membuat seek video dan HTTP Range murah.

Streaming: `<video src="/stream/<id>/<nama>">` dicegat oleh `public/sw.js`. Worker meminta byte ke tab aplikasi lewat `MessageChannel`, lalu tab mengambil blok dari Telegram, mendekripsi, dan mengirimkannya kembali. Kunci tidak pernah keluar dari tab.

| File | Isi |
|---|---|
| `src/core/blocks.js` | Matematika blok/part/range |
| `src/core/crypto.js` | PBKDF2, AES-GCM, format sealed blob |
| `src/core/tg.js` | Wrapper GramJS: login, channel, upload part, getFile lintas DC, retry FLOOD_WAIT |
| `src/core/drive-index.js` | Model folder tree (murni, teruji) |
| `src/core/drive.js` | Simpan/muat index, deteksi konflik antar perangkat |
| `src/core/uploader.js` | Antrean upload paralel, batal, ulangi |
| `src/core/reader.js` | Baca range acak + cache + read-ahead |
| `src/core/stream.js`, `public/sw.js` | Jembatan streaming Service Worker |
| `src/ui/*` | Antarmuka |

## Keamanan

- **Passphrase tidak bisa dipulihkan.** Lupa passphrase berarti file tidak bisa dibuka lagi.
- Sesi Telegram disimpan di localStorage **dalam keadaan terenkripsi** dengan passphrase. Tanpa passphrase, sesi tidak bisa dipakai.
- Build produksi memasang CSP ketat (hanya `wss://*.web.telegram.org`). Konten file yang didekripsi disajikan dengan `CSP: sandbox`, jadi HTML/SVG yang diunggah tidak bisa menjalankan script di origin aplikasi.
- Nama asli file tidak pernah dikirim ke Telegram.

## Batasan yang perlu diketahui

- Tab harus tetap terbuka selama upload/unduh/stream berjalan. Upload yang terputus karena reload harus diulang dari awal.
- Unduh folder sebagai ZIP belum ada (unduh per file).
- Ganti passphrase belum ada.
- Memakai Telegram sebagai cloud storage massal termasuk area abu-abu di ToS Telegram, jadi akun bisa terkena limit. Jangan jadikan ini satu-satunya backup.
- Firefox mode privat menonaktifkan Service Worker. Aplikasi otomatis beralih ke mode memori (pratinjau/unduh maks. 1 GB).

## Lisensi

MIT
