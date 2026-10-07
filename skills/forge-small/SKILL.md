---
name: forge-small
description: Use when forge triage says SMALL (a fix or a contained change). Plan, clarify up front, build, then the Stop hook runs the tests and re-prompts until green or the revision cap.
---

# forge: small task harness

`forge` = `node ${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs`.

1. **PLAN.** `forge new <KEY> --mode small --title "..."`. Read the code first, then pipe a
   plan into `forge plan --stdin`:
   ```json
   {"steps": ["..."], "files": ["src/x.ts"], "test_cmd": "npm test",
    "regression_cmd": "npm test -- tests/existing",
    "cases": [
      {"id": "happy-1", "kind": "happy", "cmd": "npx vitest run t/x.test.ts -t ok"},
      {"id": "unhappy-1", "kind": "unhappy", "cmd": "..."},
      {"id": "edge-1", "kind": "edge", "cmd": "..."}]}
   ```
   Happy, unhappy and edge cases are mandatory; add a regression case for each caller of
   what you change. If `forge plan` says pass-2 triage is LARGE, stop and propose a large task.
2. **CLARIFY.** Ask open decisions now, in one AskUserQuestion batch with your
   recommendation. Do not ask what the repo answers.
3. **BUILD.** `forge phase BUILD`, implement, write the tests from the plan.
4. **TEST/JUDGE.** End your turn. The Stop hook runs every case plus `test_cmd`. Red:
   it blocks the stop with the failing cases and a failure class; fix the cause (never
   weaken, skip or delete a test) and end the turn again. Green: DONE, summarise with
   evidence. After the revision cap it escalates: report the failures to the owner.
