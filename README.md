# forge

Plugin Claude Code untuk loop engineering berkelanjutan. Hooks klasik (tidak butuh flag
function-hooks), CLI `forge`, skill `forge-small` / `forge-large`, slash command
`/forge:start`, `/forge:status`, `/forge:doctor`.

## Install

    claude plugin marketplace add ~/forge
    claude plugin install forge@forge-local
    forge doctor --install-shim        # cek prasyarat + pasang shim ~/.local/bin/forge

Coba tanpa install: `claude --plugin-dir ~/forge`.

## Alur

- Setiap prompt di-triage (Jev, lane zen lalu commandcode; gagal = fallback deterministik):
  `none` (pertanyaan), `clarify` (kabur, tidak ada kriteria terukur), `small`, `large`.
- Small: PLAN (wajib happy + unhappy + edge) lalu CLARIFY di depan, BUILD, lalu hook Stop
  menjalankan tes dan memaksa revisi sampai hijau, maksimal 3 revisi, lalu eskalasi.
  Kalau plan ternyata besar, triage tahap 2 mengusulkan naik ke large (tidak pernah turun).
- Large: intake sumber (Jira / Google Doc / PDF / markdown / PRD / Figma) lalu goal + spec
  (tiap AC wajib punya sumber), validasi codebase (in scope / impacted / out of scope /
  conflict), worklist + test matrix, rekomendasi jumlah subagent tanpa tabrakan file,
  baseline, clarify A sampai J, spec lock (approve owner), loop di background.
- Loop: tiap iterasi = lane paralel (claude -p segar per lane, worktree sendiri, file
  eksklusif), orchestrator memutuskan temuan berdasarkan baris spec/goal/clarify yang
  dikutip (kutipan palsu = BLOCKED), judge deterministik (matrix + suite + regresi vs
  baseline + metrik). Keep hanya kalau hijau, tanpa regresi, dan membaik; selain itu reset.
- Berhenti: target tercapai, budget habis, plateau N, semua sisa item BLOCKED, atau stop.
- Laporan akhir ke target yang dipilih di awal (telegram via hermes send, komentar Jira, file).
- Self-learning: instinct per repo di ~/.forge/learn (format squad), hanya dari bukti run.

## Tes

    bash tests/e2e/run-large.sh   # alur large penuh dengan agent stub (deterministik)
    bash tests/e2e/run-small.sh   # small harness, gate lane, triage live (Jev zen)

## Konfigurasi

userConfig plugin (`claude plugin configure forge`) atau `~/.forge/env`:
FORGE_JEV_LANES, COMMANDCODE_API_KEY, TYPESAFE_API_KEY, OPENROUTER_API_KEY,
FORGE_MAX_WORKERS, FORGE_WORKER_MEM_MB, FORGE_SMALL_MAX_REVISIONS, FORGE_AUTO_TRIAGE,
JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN (fallback REST kalau Jira MCP tidak ada).
