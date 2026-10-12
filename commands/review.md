---
description: Review mode, read-only. forge denies file edits and mutating commands in this session until /forge:change
argument-hint: <what to review>
---
forge has put this session in review mode (read-only). Review what the owner asked: $ARGUMENTS

Report findings with file:line evidence, ordered by impact. Do not edit files, do not run commands
that change files or state, and do not start fixing. If a fix is clearly wanted, say what you would
change and let the owner switch with `/forge:change`.
