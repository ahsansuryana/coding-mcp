# coding-mcp

Server MCP minimal untuk menjalankan perintah dan mengelola file di mesin sendiri, lewat transport **Streamable HTTP** di endpoint `/mcp`. Dibangun dengan TypeScript, Express, dan `@modelcontextprotocol/sdk`.

> **Peringatan keamanan.** Tool `bash_tool` adalah eksekusi perintah jarak jauh (RCE) by design. Siapa pun yang punya token bisa menjalankan perintah apa saja dengan hak akses user yang menjalankan server ini. Baca bagian [Keamanan](#keamanan) sebelum membuka server ke jaringan.

## Tool

| Tool | Fungsi |
|---|---|
| `bash_tool` | Menjalankan perintah bash di server (timeout 60 detik, output dipotong 30.000 karakter) |
| `create_file` | Membuat file baru. Gagal kalau path sudah ada |
| `str_replace` | Mengganti satu string unik di file. Gagal kalau string tidak ada atau muncul lebih dari sekali |
| `view` | Melihat file teks (bernomor baris, bisa `view_range`), gambar, atau isi direktori (2 level) |

Tool file (`create_file`, `str_replace`, `view`) dibatasi di dalam `WORKDIR`. `bash_tool` **tidak** dibatasi oleh `WORKDIR` (hanya `cwd`-nya), jadi isolasi sebenarnya harus dilakukan di level OS atau container.

## Kebutuhan

- Node.js 18 atau lebih baru
- Bash. Di Windows, pakai Git Bash

## Instalasi

```bash
npm install
```

Dependensi utama: `@modelcontextprotocol/sdk`, `express`, `zod`, `dotenv`. Dev: `typescript`, `tsx`, `@types/express`, `@types/node`.

## Konfigurasi

Buat file `.env` di root proyek:

```
MCP_TOKEN=ganti-dengan-token-acak-panjang
WORKDIR=./workspace
PORT=3000
HOST=127.0.0.1
SHELL_PATH=
```

| Variabel | Wajib | Default | Keterangan |
|---|---|---|---|
| `MCP_TOKEN` | Ya | - | Token bearer, minimal 16 karakter. Server menolak start kalau kosong atau terlalu pendek |
| `WORKDIR` | Tidak | `./workspace` | Folder kerja. Dibuat otomatis kalau belum ada |
| `PORT` | Tidak | `3000` | Port HTTP |
| `HOST` | Tidak | `127.0.0.1` | Alamat bind. Isi `0.0.0.0` untuk menerima koneksi dari jaringan |
| `SHELL_PATH` | Tidak | shell default sistem | Path lengkap ke executable shell. Server menolak start kalau path tidak ada |

Membuat token acak:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Windows (Git Bash)

Di Windows, shell default `exec` adalah `cmd.exe`, bukan bash. Set `SHELL_PATH` ke `bash.exe` milik Git:

```
SHELL_PATH=C:\Program Files\Git\bin\bash.exe
```

Catatan:

- Tulis path **tanpa tanda kutip** dan backslash tidak perlu digandakan.
- Pakai `Git\bin\bash.exe` (wrapper yang menyiapkan PATH sehingga `ls`, `cat`, `grep` ditemukan), bukan `Git\usr\bin\bash.exe`.
- Cara mencari lokasinya: di Git Bash jalankan `cygpath -w "$(which bash)"`, lalu ganti `usr\bin` dengan `bin` kalau file wrapper-nya ada.
- Jangan pakai `shell: "bash"` tanpa path lengkap, karena Node bisa menemukan `bash.exe` milik WSL di `System32`.

### Linux / macOS / Docker

Kosongkan `SHELL_PATH` untuk memakai `/bin/sh`. Kalau butuh fitur bash (heredoc, array, dll), isi `SHELL_PATH=/bin/bash`.

## Menjalankan

```bash
npm run start
```

Output hanya satu baris berisi URL endpoint, misalnya:

```
http://127.0.0.1:3000/mcp
```

Untuk development dengan auto-reload:

```bash
npm run dev
```

Kalau `HOST=0.0.0.0`, URL yang tercetak bukan alamat untuk klien. Dari mesin yang sama pakai `http://127.0.0.1:PORT/mcp`, dari perangkat lain pakai IP mesin.

## Autentikasi

Setiap request ke `/mcp` wajib membawa header:

```
Authorization: Bearer <MCP_TOKEN>
```

Tanpa header yang benar, server membalas `401`. Server ini **tidak** menyediakan OAuth dan endpoint `/.well-known/*` sengaja mengembalikan `404` supaya klien tidak mencoba alur OAuth.

## Tes

Tanpa token, harus `401`:

```bash
curl -i -X POST http://127.0.0.1:3000/mcp
```

Dengan token, harus `200` berisi daftar tool:

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

1. Transport Type: **Streamable HTTP**
2. URL: `http://127.0.0.1:3000/mcp`
3. Di bagian **Authentication**, isi header `Authorization` dengan nilai `Bearer <MCP_TOKEN>`
4. Klik **Connect**

Isi header **sebelum** Connect. Kalau tidak, 401 pertama bisa memicu alur OAuth di Inspector.

Lalu coba `bash_tool` dengan:

```json
{ "command": "echo $BASH_VERSION; ls", "description": "cek shell" }
```

## Keamanan

1. **Jalankan sebagai user non-root** dan sebaiknya di Docker atau VM. Mount hanya folder workspace, bukan seluruh disk.
2. **Jangan expose HTTP polos ke internet.** Token bearer terkirim sebagai teks biasa, dan siapa pun yang mendapatkannya mendapat shell. Pasang TLS di depan server (Caddy, Nginx, atau Cloudflare Tunnel).
3. Kalau proxy atau tunnel berjalan di mesin yang sama, biarkan `HOST=127.0.0.1`.
4. **Jangan commit `.env`.** Tambahkan ke `.gitignore`:

   ```
   .env
   workspace/
   node_modules/
   ```
5. Ganti token secara berkala, dan matikan access log pada path `/mcp` kalau header bisa ikut tercatat.
6. Windows Firewall akan menanyakan izin saat bind ke `0.0.0.0`. Izinkan hanya untuk jaringan privat.

## Batasan yang perlu diketahui

- **Stateless.** Server dan transport dibuat baru untuk tiap request. Tidak ada sesi, dan `cd` tidak bertahan antar panggilan `bash_tool` (tiap perintah adalah proses baru).
- **Timeout di Windows** hanya mematikan proses bash, bukan proses anak yang dijalankan di dalamnya. Jangan menjalankan proses yang berjalan terus (misalnya `npm run dev`) lewat `bash_tool`.
- **Path Git Bash vs Windows.** Di dalam `bash_tool`, path terlihat sebagai `/f/mcp/...`, sedangkan tool `view`, `create_file`, dan `str_replace` memakai path Windows atau path relatif terhadap `WORKDIR`. Pakai path relatif agar tidak bingung.
- **Tidak cocok sebagai custom connector Claude.ai**, karena Claude.ai mengharapkan OAuth dan tidak bisa mengirim header bearer statis. Server ini cocok untuk klien yang bisa mengatur header sendiri, seperti MCP Inspector dan Claude Code.

## Struktur

```
coding-mcp/
├── src/
│   └── server.ts
├── workspace/        # WORKDIR default (dibuat otomatis)
├── .env              # konfigurasi lokal, jangan di-commit
├── package.json
└── README.md
```

## Troubleshooting

| Gejala | Penyebab umum |
|---|---|
| `exit: ENOENT` saat memanggil `bash_tool` | Shell tidak ditemukan atau `WORKDIR` terhapus. Periksa `SHELL_PATH` |
| `SHELL_PATH tidak ditemukan` saat start | Path salah. Cek dengan `Test-Path` (PowerShell) |
| `MCP_TOKEN belum di-set...` | `.env` tidak terbaca. Jalankan dari root proyek dan pastikan token minimal 16 karakter |
| `ls: command not found` | Memakai `usr\bin\bash.exe` tanpa PATH. Pakai `bin\bash.exe` |
| Inspector mengarah ke `/oauth/authorize` | Ada proses lain di port yang sama, atau header belum diisi sebelum Connect. Cek dengan `netstat -ano \| findstr :3000` |
| `Path di luar WORKDIR` | Path yang diminta berada di luar `WORKDIR`. Gunakan path relatif |
