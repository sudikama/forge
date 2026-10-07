---
description: Start a forge task (triage, then the small harness or the large loop)
argument-hint: <request, ticket key, or doc link>
---
Run `node "${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs" triage "$ARGUMENTS"` and read the `lane`.
- `clarify`: ask the owner what done means (observable behaviour, test or metric) before anything else.
- `small`: follow the forge-small skill.
- `large`: follow the forge-large skill. Do not write product code in this session.
Tell the owner the triage result and the signals in one line first.
