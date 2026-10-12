---
description: forge scope guard, recent decisions, labels, or turn the session mode off
argument-hint: [off | label <id> correct|incorrect|unclear]
---
Run `node "${CLAUDE_PLUGIN_ROOT}/bin/forge.mjs" guard $ARGUMENTS --session ${CLAUDE_SESSION_ID}` and
summarise for the owner: the session mode, how many actions each rule denied, asked or only
observed, any labelled incorrect, and the most recent decisions.
