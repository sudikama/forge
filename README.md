# forge

Plugin Claude Code untuk *continuous engineering loop*. Setiap permintaan dipilah menjadi
kecil, besar, atau kabur. Tugas kecil dikerjakan lewat harness plan, clarify, build, test,
revise. Tugas besar dijalankan sebagai loop ala autoresearch: orchestrator, subagent paralel
di worktree masing-masing, dan judge deterministik, sampai goal tercapai.

Jev (decision model TypeSafe) dipakai untuk triage, presort temuan, dan klasifikasi kegagalan.
Model pekerja tetap Claude, tanpa proxy.

---

## Daftar isi

1. [Prasyarat](#1-prasyarat)
2. [Install plugin](#2-install-plugin)
3. [Konfigurasi](#3-konfigurasi)
4. [Sumber spec: MCP Jira, Google Drive, Figma](#4-sumber-spec-mcp-jira-google-drive-figma)
5. [Verifikasi setup](#5-verifikasi-setup)
6. [Cara pakai](#6-cara-pakai)
7. [Alur detail](#7-alur-detail)
8. [Referensi CLI](#8-referensi-cli)
9. [Struktur repo dan file task](#9-struktur-repo-dan-file-task)
10. [Tes](#10-tes)
11. [Troubleshooting](#11-troubleshooting)
12. [Batasan yang diketahui](#12-batasan-yang-diketahui)

---

## 1. Prasyarat

| Kebutuhan | Catatan |
|---|---|
| Claude Code | 2.1.280 atau lebih baru (`claude --version`) |
| Login Claude Code | `claude` lalu `/login`, atau `ANTHROPIC_API_KEY`. Wajib untuk loop besar karena tiap subagent adalah proses `claude -p` |
| Node.js | 20 atau lebih baru. forge hanya memakai modul bawaan Node, tidak perlu `npm install` |
| git | repo target harus repo git dengan minimal satu commit |
| Opsional | `pdftotext` (poppler-utils) atau `pymupdf` untuk ekstrak PDF; `hermes send` untuk laporan ke Telegram |

## 2. Install plugin

### Opsi A: langsung dari GitHub (disarankan)

Repo ini sekaligus marketplace (`.claude-plugin/marketplace.json`, nama `forge-local`).

```bash
claude plugin marketplace add sudikama/forge
claude plugin install forge@forge-local
```

Repo ini private, jadi mesin tersebut harus bisa clone `git@github.com:sudikama/forge.git`
(SSH key yang terdaftar di GitHub, atau `gh auth login`).

### Opsi B: dari clone lokal

```bash
git clone git@github.com:sudikama/forge.git ~/forge
claude plugin marketplace add ~/forge
claude plugin install forge@forge-local
```

### Opsi C: coba tanpa install

```bash
claude --plugin-dir ~/forge
```

Plugin hanya aktif untuk sesi itu. Cocok untuk mencoba sebelum dipasang permanen.

### Scope instalasi

Default-nya `user` (aktif di semua repo). Untuk membatasi ke satu project, jalankan dari root
project tersebut:

```bash
claude plugin marketplace add sudikama/forge --scope project
claude plugin install forge@forge-local --scope project
```

### Shim CLI `forge`

Skill dan slash command memanggil `node ${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs`, jadi shim tidak
wajib. Supaya bisa memanggil `forge` langsung dari terminal:

```bash
node ~/forge/bin/forge.mjs doctor --install-shim   # menulis ~/.local/bin/forge
```

Kalau install lewat Opsi A, path plugin ada di cache Claude Code; cari dengan
`claude plugin list --json` atau pakai clone lokal untuk shim. Pastikan `~/.local/bin` ada di `PATH`.

### Update dan uninstall

```bash
claude plugin marketplace update forge-local
claude plugin update forge@forge-local
claude plugin uninstall forge@forge-local
```

Setelah install atau update, mulai sesi Claude Code baru supaya hooks terbaca.

## 3. Konfigurasi

Ada dua tempat. Keduanya boleh dipakai bersamaan; env proses menang atas file.

**a. userConfig plugin** (tersimpan di settings Claude Code):

```bash
claude plugin configure forge@forge-local      # tampilkan opsi dan yang belum diisi
```

**b. File `~/.forge/env`** (format `KEY=value`, juga dibaca CLI di luar Claude Code):

```bash
mkdir -p ~/.forge && chmod 700 ~/.forge
cat > ~/.forge/env <<'EOF'
FORGE_JEV_LANES=zen,commandcode
COMMANDCODE_API_KEY=
FORGE_MAX_WORKERS=4
EOF
chmod 600 ~/.forge/env
```

| Opsi | Default | Arti |
|---|---|---|
| `jevLanes` / `FORGE_JEV_LANES` | `zen,commandcode` | Urutan failover backend Jev: `zen` (opencode, gratis, tanpa key), `commandcode` (200 request per hari), `typesafe`, `openrouter` |
| `COMMANDCODE_API_KEY` | kosong | Key lane commandcode |
| `TYPESAFE_API_KEY` | kosong | Key lane typesafe (satu-satunya yang confidence-nya terkalibrasi) |
| `OPENROUTER_API_KEY` | kosong | Key lane openrouter (API decisions masih alpha) |
| `jevTimeoutMs` / `FORGE_JEV_TIMEOUT_MS` | 8000 | Batas tunggu per lane; lewat batas, lane berikutnya dicoba |
| `autoTriage` / `FORGE_AUTO_TRIAGE` | true | Triage setiap prompt engineering |
| `maxWorkers` / `FORGE_MAX_WORKERS` | 4 | Batas keras subagent paralel |
| `FORGE_WORKER_MEM_MB` | 1200 | Perkiraan RAM per subagent; jumlah worker juga dibatasi RAM bebas |
| `smallMaxRevisions` / `FORGE_SMALL_MAX_REVISIONS` | 3 | Revisi maksimal tugas kecil sebelum eskalasi |
| `FORGE_VERIFIER_THRESHOLD` | 0.3 | Di bawah nilai ini, permintaan yang tidak kecil dianggap kabur dan wajib clarify |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` | kosong | Fallback REST kalau Jira MCP tidak dipasang; juga untuk komentar laporan ke Jira |
| `FORGE_HOME` | `~/.forge` | Lokasi state global: breaker Jev, log, instinct |

Semua panggilan Jev bersifat *fail-open*. Kalau semua lane gagal, forge memakai aturan
deterministik dan tidak pernah memblokir sesi.

## 4. Sumber spec: MCP Jira, Google Drive, Figma

Tugas besar wajib punya sumber. forge membekukan salinannya di `.forge/tasks/<KEY>/source/`
beserta hash. Konten dibaca Claude lewat MCP lalu di-pipe ke `forge source add --stdin`.

Daftarkan server MCP yang dipakai (contoh, sesuaikan dengan server pilihan):

```bash
# Jira: server MCP apa pun yang menyediakan get_issue
claude mcp add jira -- node /path/to/jira-mcp/dist/index.js

# Figma: Dev Mode MCP remote
claude mcp add --transport http figma https://mcp.figma.com/mcp

# Google Drive / Docs: server MCP yang mendukung OAuth; login OAuth dilakukan sendiri
claude mcp add gdrive -- npx -y <paket-mcp-google-drive>

# Opsional: analisis dampak untuk scope.json
claude mcp add codebase-memory -- <perintah server codebase-memory>

claude mcp list
```

Tanpa MCP tetap bisa jalan:

| Sumber | Tanpa MCP |
|---|---|
| Jira | `forge source add --kind jira --ref KEY` memakai `JIRA_*` di `~/.forge/env` |
| PDF | `forge source add --kind pdf --file x.pdf` (butuh pdftotext atau pymupdf), atau Claude membaca PDF dengan tool Read lalu pipe teksnya |
| Markdown / PRD | `forge source add --kind markdown --file path` atau `--kind prd` |
| Google Doc / Figma | export manual ke markdown, lalu `--kind gdoc --ref <url> --stdin` atau `--kind figma` |

## 5. Verifikasi setup

Di Claude Code: `/forge:doctor`. Di terminal:

```bash
forge doctor
```

Contoh keluaran yang sehat:

```
ok   claude code: 2.1.292 (Claude Code)
ok   claude auth (needed by loop agents): logged in
ok   jev lane zen: noul 0.19 in 1040ms
FAIL jev lane commandcode: COMMANDCODE_API_KEY not set
ok   jira mcp: registered
ok   forge on PATH: /home/you/.local/bin/forge
```

`FAIL` untuk lane tanpa key atau MCP yang memang tidak dipakai boleh diabaikan. Untuk loop besar
yang wajib `ok`: `claude code`, `claude auth`, `git`. Lane Jev sebaiknya minimal satu `ok`; tanpa
itu forge tetap jalan dengan fallback deterministik, hanya triage-nya lebih kasar.

Uji cepat triage:

```bash
forge triage "tambahkan fungsi money() untuk format rupiah lengkap dengan unit test"
```

## 6. Cara pakai

Ketik permintaan di Claude Code seperti biasa, di dalam repo git. Hook `UserPromptSubmit`
memilah lalu menyisipkan instruksi ke sesi:

| Hasil triage | Yang terjadi |
|---|---|
| `none` | pertanyaan atau obrolan, forge diam |
| `clarify` | permintaan kabur (tidak ada kriteria selesai yang bisa dicek); Claude wajib bertanya dulu |
| `small` | harness kecil (skill `forge-small`) |
| `large` | alur besar (skill `forge-large`); Claude dilarang langsung menulis kode produk |

Slash command:

- `/forge:start <permintaan | KEY tiket | link doc>`: triage manual lalu mulai
- `/forge:status`: state, gate yang belum lolos, progres loop, item BLOCKED
- `/forge:doctor`: cek prasyarat

## 7. Alur detail

### Tugas kecil

1. **PLAN**: `forge new KEY --mode small`, lalu plan JSON (file, `test_cmd`, kasus happy,
   unhappy, edge) lewat `forge plan --stdin`. Tanpa ketiga jenis kasus, BUILD ditolak.
2. **CLARIFY**: keputusan terbuka ditanyakan di depan dalam satu batch.
3. **BUILD**: `forge phase BUILD`, lalu implementasi.
4. **TEST, JUDGE, REVISE**: saat Claude mengakhiri turn, hook `Stop` menjalankan semua kasus dan
   `test_cmd`. Merah: turn tidak boleh berakhir, Claude menerima kasus yang gagal beserta kelas
   kegagalannya. Hijau: DONE. Setelah 3 revisi masih merah: eskalasi ke user.
5. Kalau plan ternyata menyentuh banyak file atau modul, forge mengusulkan naik ke tugas besar.

### Tugas besar

Setiap tahap punya gate. `forge check` menunjukkan apa yang masih kurang.

1. **Intake**: tanya tujuan laporan akhir dan sumber (Jira, Google Doc, PDF, markdown, PRD, Figma).
2. **Goal dan spec**: `goal.json` (test_cmd, regression_cmd, metrik dengan arah dan target, budget,
   file editable, file locked) dan `spec.md` (setiap AC wajib `(source: ...)`).
3. **Validasi codebase**: `scope.json` berisi in scope, impacted (beserta tes yang menutupinya),
   out of scope, dan conflict, semuanya dengan bukti `file:line`.
4. **Worklist dan test matrix**: slice vertikal dengan file yang dimiliki. Matrix wajib punya kasus
   happy, unhappy, edge per AC dan kasus regresi per path impacted.
5. **Lanes**: `forge lanes` mengelompokkan item yang bertabrakan file, mensimulasikan 1 sampai N
   worker, dan merekomendasikan jumlah terkecil yang waktunya mendekati tercepat, dibatasi hard cap,
   RAM bebas, dan kuota. File bersama (lockfile, router, migration) hanya milik orchestrator.
6. **Baseline**: matrix, suite, dan metrik dijalankan dua kali di HEAD (deteksi flaky).
7. **Clarify A sampai J**: goal, scope, requirement, testing, eksekusi (jumlah subagent dan
   kepemilikan file), budget, wewenang orchestrator, keamanan, laporan, instinct yang dipelajari.
8. **Spec lock**: hanya dengan persetujuan eksplisit (`forge lock --approve`). Goal, spec, scope,
   matrix, baseline, dan file locked di-hash; edit ke file itu ditolak hook PreToolUse.
9. **Loop** (`forge run`, background). Tiap iterasi:
   - setiap lane adalah `claude -p` baru di worktree sendiri dan hanya boleh menulis file miliknya;
   - temuan dilaporkan lewat `forge finding`. Orchestrator memutuskan dengan mengutip baris
     spec, goal, clarify, atau scope. Kutipan yang tidak valid otomatis jadi BLOCKED. Bug lama dan
     ide refactor jadi usulan tiket. Item BLOCKED dilewati dan loop lanjut;
   - judge deterministik: iterasi disimpan hanya jika tidak ada regresi terhadap baseline, jumlah
     AC lulus tidak turun, suite lama tetap hijau, dan ada kemajuan (AC atau metrik). Selain itu
     `git reset`.
   - Loop berhenti saat target tercapai, budget iterasi atau waktu habis, N iterasi tanpa kemajuan,
     semua sisa item BLOCKED, atau `forge stop`.
10. **Laporan**: `report.md` berisi item selesai, BLOCKED beserta pertanyaan dan opsi, usulan tiket,
    keputusan orchestrator, kurva metrik, dan instinct. Dikirim ke target yang dipilih di awal.
    forge tidak pernah merge atau push.

### Self-improvement

Instinct per repo disimpan di `~/.forge/learn/repos/<repo>/` (format sama dengan instinct
hermes-squad; instinct squad hanya dibaca). Sumbernya hanya bukti run: perintah tes yang terbukti
hijau, error berulang yang akhirnya terselesaikan, kasus yang berhasil menangkap regresi, dan
koreksi user (`forge answer ... --correction "..."`). Confidence awal 0.5, naik 0.1 bila
terkonfirmasi, turun 0.2 bila terbantah, dihapus di bawah 0.4. Perubahan template, prompt, atau
kode forge hanya muncul sebagai usulan di laporan.

## 8. Referensi CLI

```
forge doctor [--install-shim]          cek prasyarat
forge triage "<permintaan>"            triage ukuran dan kejelasan
forge new <KEY> --mode small|large --title ".." --report-to telegram:CHAT:THREAD,jira:KEY,file
forge source add --kind jira|gdoc|pdf|markdown|prd|figma|file (--ref X | --file P | --stdin)
forge template goal|spec|scope|matrix|worklist [--write]
forge check                            validasi artefak, naikkan state, tampilkan langkah berikut
forge lanes                            rekomendasi jumlah subagent
forge baseline [--force]               baseline di HEAD
forge clarify [--json]                 daftar pertanyaan bernomor
forge answer <ID> "<jawaban>" [--correction "<pelajaran>"]
forge lock --approve                   spec lock
forge run [--foreground]               jalankan loop
forge status | pause | stop | resume
forge finding --kind K --title T --evidence E [--item W1] [--options "a|b"]
forge findings | report [--regenerate]
forge plan --stdin | phase PLAN|CLARIFY|BUILD|TEST     (tugas kecil)
forge learn list | correct "<teks>" | contradict <id>
forge use <KEY> | list
```

Target laporan: `telegram` (home channel) atau `telegram:<chat_id>[:<thread_id>]` lewat
`hermes send`, `jira:<KEY>` (komentar), `file` (hanya `report.md`).

## 9. Struktur repo dan file task

```
.claude-plugin/plugin.json        manifest dan userConfig
.claude-plugin/marketplace.json   marketplace forge-local
hooks/hooks.json                  SessionStart, UserPromptSubmit, PreToolUse, Stop
bin/forge.mjs                     CLI tunggal (dipakai hooks, skill, lane)
lib/                              jev, triage, task, lanes, judge, runner, small, clarify, learn, io, report, hooks
skills/forge-small, forge-large   instruksi untuk Claude
commands/                         /forge:start, /forge:status, /forge:doctor
templates/                        goal, spec, scope, worklist, matrix, prompt lane dan orchestrator
tests/e2e/                        fixture dan tes end-to-end
```

Di repo target, forge menulis ke `.forge/` (otomatis masuk `.git/info/exclude`):

```
.forge/active                     task aktif
.forge/tasks/<KEY>/               task.json, source/, goal.json, spec.md, scope.json,
                                  worklist.json, matrix.json, lanes.json, baseline.json,
                                  clarify.json, decisions.md, findings/, decisions/,
                                  agents/ (prompt dan log per agent), iterations/,
                                  results.tsv, ledger.md, report.md
.forge/wt/<KEY>/                  worktree integ, lane-a, lane-b, ...
```

Branch loop: `forge/<KEY>` (hasil terbaik) dan `forge/<KEY>-lane-<x>`.

## 10. Tes

```bash
bash tests/e2e/run-large.sh   # alur besar penuh dengan agent stub (deterministik, tanpa biaya)
bash tests/e2e/run-small.sh   # harness kecil, gate lane, triage live (Jev zen)
```

`run-large.sh` mengganti `claude -p` dengan agent stub lewat `FORGE_AGENT_CMD`, lalu memverifikasi:
gate tiap tahap, lock butuh approval, iterasi dengan regresi dibuang, lane yang menyentuh file locked
ditolak, keputusan orchestrator dengan kutipan valid, kutipan palsu jadi BLOCKED, usulan tiket, isi
laporan, instinct terbawa ke task berikutnya, dan branch dasar tidak tersentuh.

## 11. Troubleshooting

| Gejala | Penyebab dan solusi |
|---|---|
| Hooks tidak jalan | mulai sesi baru setelah install; cek `claude plugin list` |
| `claude auth: not logged in` | jalankan `claude` lalu `/login`, atau set `ANTHROPIC_API_KEY` |
| Jev lane `HTTP 403` | Cloudflare; forge sudah mengirim User-Agent browser. Coba lagi atau pindah lane |
| Lane commandcode tertutup 1 jam | kuota harian habis; breaker membuka lagi otomatis |
| `cannot lock, gates still failing` | jalankan `forge check`, perbaiki item yang tercantum |
| `baseline ran at X but HEAD is Y` | ada commit baru setelah baseline; jalankan `forge baseline` lagi |
| `new-behaviour case already green at baseline` | tes AC tidak benar-benar menguji fitur baru; perbaiki tesnya |
| Loop berhenti `every remaining item is blocked` | jawab item BLOCKED di `report.md`, perbarui spec atau clarify, lalu buat task lanjutan |
| Hanya 1 worker padahal item banyak | RAM bebas kecil atau item saling bertabrakan file; lihat `forge lanes` |
| Log | `~/.forge/logs/hooks.jsonl`, `~/.forge/logs/jev.jsonl`, `.forge/tasks/<KEY>/runner.log` |

## 12. Batasan yang diketahui

- Loop besar sudah diuji end-to-end dengan agent stub. Uji dengan `claude -p` sungguhan bergantung
  pada login Claude Code di mesin tersebut.
- Routing effort per turn dan compaction berbasis Jev belum ada (butuh function hooks yang masih
  early access).
- Threshold triage baru dikalibrasi dengan sedikit contoh. Pakai `forge triage` untuk mengecek
  permintaan yang terasa salah pilah.
- Deteksi regresi hanya sekuat tes yang ada ditambah characterization test yang ditulis di baseline.
