---
name: forge-small
description: Use when forge triage says SMALL (a fix or a contained change). Plan, clarify up front, build, then the Stop hook runs the tests and re-prompts until green or the revision cap.
---

# forge: small task harness

`forge` = `node ${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs`.

1. **PLAN.** `forge new <KEY> --mode small --title "..."`. Read the code first, then pipe a
   plan into `forge plan --stdin`:
   ```json
   {"steps": ["..."], "files": ["src/x.ts"], "tests": ["t/x.test.ts"], "test_cmd": "npm test",
    "allow": {"deps": [], "hash": false},
    "regression_cmd": "npm test -- tests/existing",
    "cases": [
      {"id": "happy-1", "kind": "happy", "cmd": "npx vitest run t/x.test.ts -t ok"},
      {"id": "unhappy-1", "kind": "unhappy", "cmd": "..."},
      {"id": "edge-1", "kind": "edge", "cmd": "..."}]}
   ```
   Happy, unhappy and edge cases are mandatory; add a regression case for each caller of
   what you change. `files` + `tests` is the write boundary during BUILD: list every caller,
   migration and test the change needs (trace them first), nothing speculative. Put a
   dependency or hashing in `allow` only when the owner asked for it or a named consumer needs it. If `forge plan` says pass-2 triage is LARGE, stop and propose a large task.
2. **CLARIFY.** Ask open decisions now, in one AskUserQuestion batch with your
   recommendation. Do not ask what the repo answers.
3. **BUILD.** `forge phase BUILD`, implement, write the tests from the plan.
4. **TEST/JUDGE.** End your turn. The Stop hook runs every case plus `test_cmd`. Red:
   it blocks the stop with the failing cases and a failure class; fix the cause (never
   weaken, skip or delete a test) and end the turn again. Green: DONE, summarise with
   evidence. After the revision cap it escalates: report the failures to the owner.
   Ending a turn without changing anything after a red run does not re-run the tests; twice
   in a row escalates. Fix something or say what blocks you.

## Stop Ladder (finish the work, stop the extras)
1. Know the responsibility: the requested result, explicit boundaries, guarantees to keep. Trace callers
   and failure paths first, then finish the necessary caller, data, test and doc changes. A plan or an
   easier subset is not the result.
2. Start direct: existing project code, the standard library, installed dependencies.
3. Expand only to close a concrete gap (a supported input, consumer, failure or existing commitment).
   A larger diff is fine when it completes the affected flow; hypothetical future needs are not a gap.
4. Judge a defense by its effect: what it detects and what its rejection, recovery or diagnosis
   changes. Keep effective ones, skip ones nobody reads (a checksum with no consumer), repair ones
   that hide failures.
5. Verify and finish: run the intended checks once on the final state; do not repeat a check when
   nothing changed. Done when the result exists, the evidence supports it, and no in-scope blocker
   remains.

