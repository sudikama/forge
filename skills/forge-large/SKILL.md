---
name: forge-large
description: Use when forge triage says LARGE, or the owner asks for a big feature, migration, epic or a goal loop. Runs intake, goal+spec, scope validation, worklist+matrix, lanes, baseline, clarify, spec lock, then the background loop.
---

# forge: large task (goal + spec + orchestrated loop)

Never write product code in the session for a large task. The loop's lanes write code;
this session prepares and locks the contract. Every step is checked by `forge check`,
which prints what is still missing. `forge` = `node ${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs`
(or the `forge` shim after `forge doctor --install-shim`).

## 1. Intake
1. Ask the owner (AskUserQuestion, one batch): the task key, where the final report goes
   (`jira:<KEY>`, `webhook:<url>`, `command`, `file`), and every source of the task.
   Always ask for elaboration material: Jira ticket, Google Doc, PDF, markdown, PRD, Figma.
2. `forge new <KEY> --mode large --title "..." --report-to <targets>`
3. Freeze every source into the task (`forge source add`):
   - Jira: `--kind jira --ref KEY` (REST with ~/.forge/env) or fetch with the Jira MCP and
     pipe: `... --kind jira --ref KEY --stdin`
   - Google Doc: read with the Google Drive MCP, pipe with `--kind gdoc --ref <url> --stdin`
   - PDF: `--kind pdf --file x.pdf` (if no extractor, Read the PDF and pipe the text)
   - markdown / PRD: `--kind markdown|prd --file path`
   - Figma: read frames/annotations with the Figma MCP, pipe with `--kind figma --ref <node>`
   A source that changes later is a finding, never silently followed.

## 2. Goal + spec
`forge template goal --write` and `forge template spec --write`, then fill them in the task dir.
- goal.json: objective, test_cmd, regression_cmd (pre-existing suite only), metric
  (cmd, direction, target, measured not guessed), budget (max_iterations, max_minutes,
  plateau_n), editable globs, locked globs (evaluator, existing tests, bench).
- spec.md: every section; every AC `- [ ] AC-n: ... (source: PROJ-1#desc | PRD 3.2 | figma:1:2)`.
  Requirements without a source go to Assumptions.

## 3. Validate the codebase (before clarify)
Write scope.json with evidence (`file:line`) for everything:
- in_scope: paths the change edits, mapped to ACs (new files: `"new": true`)
- impacted: callers/consumers NOT edited but at risk; who calls it (file:line) and which
  existing tests cover it (`"tests": []` if none). Use grep and, if registered, the
  codebase-memory MCP (trace_path / detect_changes).
- out_of_scope: Non-goals and look-alike work that was not asked for
- conflicts: spec vs code mismatches, each with options and a recommendation

## 4. Worklist + test matrix
- worklist.json: vertical slices (one AC end to end), size S/M/L, `writes` globs it owns,
  `shared` files (lockfiles, routers, migrations), depends_on.
- matrix.json: per AC a happy, an unhappy and an edge case (or a waiver with a reason);
  per impacted path a regression case (existing test, or a characterization test written
  NOW at the base commit with `"characterization": true, "file": "..."`). Cases are written
  from the spec and scope, not from a diff. Every case has a runnable `cmd`.
- Commit the characterization tests on the base branch before the baseline.

## 5. Lanes + baseline
- `forge lanes`: clusters colliding items, simulates 1..cap workers, recommends the smallest
  count close to the best makespan, gives each lane exclusive files; shared files go to the
  orchestrator. If it reports `triage_pass2.large: false`, tell the owner it may be small.
- `forge baseline`: runs matrix + suite + metric at HEAD twice (flaky detection). Regression
  cases must be green and new-behaviour cases red here.

## 6. Clarify (as detailed as possible)
`forge clarify` prints numbered questions A to J (goal, scope, requirements, testing,
execution incl. number of subagents and file ownership, budget, authority, safety, report,
learned instincts), each with a recommendation. Before asking, answer from the repo
whatever is a fact, not a decision. Ask the rest in AskUserQuestion batches (max 4 per
call, recommendation first) and record each with `forge answer <ID> "<answer>"`. If the
owner corrects something forge got wrong, add `--correction "<lesson>"` (it becomes an
instinct for this repo).

## 7. Spec lock
Summarise goal, ACs, scope, lanes and budget for the owner and ask for approval.
Only after an explicit yes: `forge lock --approve`. This hashes goal/spec/scope/matrix/
baseline and every locked file; the PreToolUse gate then refuses edits to them.

## 8. Run
`forge run` starts the loop in the background (one fresh `claude -p` per lane per
iteration, in its own git worktree). `forge status` to watch; `forge pause|stop`.
Lanes report discoveries with `forge finding`; the orchestrator decides them strictly by
cited spec/goal/clarify lines, anything else becomes BLOCKED and the loop continues.
The final report (done, BLOCKED with question/options/evidence, new-ticket proposals,
metric curve, lessons) goes to the report targets. forge never merges or pushes.
