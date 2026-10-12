#!/usr/bin/env bash
# E2E scope guard through the real hook entry points (Claude Code hook JSON on stdin).
# Families: I review mode, S plan boundary + dependencies, H hashing, T thrash.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FORGE="node $HERE/../../bin/forge.mjs"
export FORGE_HOME=${TMPDIR:-/tmp}/forge-e2e/home-guard
rm -rf "$FORGE_HOME"; mkdir -p "$FORGE_HOME"
R=$(bash "$HERE/make-fixture.sh" ${TMPDIR:-/tmp}/forge-e2e/guard)
cd "$R"
FAIL=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAIL=1; }
expect() { if echo "$2" | grep -q -- "$3"; then pass "$1"; else fail "$1 (wanted: $3)"; echo "$2" | head -4; fi; }
allowed() { [ "$2" = "{}" ] && pass "$1" || { fail "$1"; echo "$2" | head -3; }; }
j() { node -e 'const [a,b,c,d]=process.argv.slice(1);const o={cwd:a,session_id:b,tool_name:c,tool_input:JSON.parse(d)};console.log(JSON.stringify(o))' "$R" "$@"; }
pre() { j "$@" | $FORGE hook pretooluse; }
prompt() { node -e 'console.log(JSON.stringify({cwd:process.argv[1],session_id:process.argv[2],prompt:process.argv[3]}))' "$R" "$1" "$2" | $FORGE hook prompt; }
edit() { node -e 'console.log(JSON.stringify({file_path:process.argv[1],old_string:process.argv[2],new_string:process.argv[3]}))' "$@"; }
bash_() { node -e 'console.log(JSON.stringify({command:process.argv[1]}))' "$1"; }

# ---- I: review mode ----
out=$(prompt RV "/forge:review look at the money formatter"); expect "I: /forge:review arms read-only mode" "$out" 'review mode: read-only'
out=$(pre RV Edit "$(edit "$R/src/fmt.mjs" "plain" "plainer")"); expect "I bad: edit denied in review mode" "$out" 'MODE\|review mode'
expect "I bad: deny is a real permission deny" "$out" '"permissionDecision":"deny"'
allowed "I good: read-only shell allowed in review mode" "$(pre RV Bash "$(bash_ 'git diff HEAD~1 && grep -rn money src | head')")"
allowed "I good: running the tests is allowed in review mode" "$(pre RV Bash "$(bash_ 'node --test tests/')")"
out=$(pre RV Bash "$(bash_ 'sed -i s/a/b/ src/fmt.mjs')"); expect "I bad: sed -i denied in review mode" "$out" '"permissionDecision":"deny"'
out=$(pre RV Bash "$(bash_ './scripts/release.sh')"); expect "I: unknown command asks in review mode" "$out" '"permissionDecision":"ask"'
allowed "I good: another session is not in review mode" "$(pre OTHER Edit "$(edit "$R/src/fmt.mjs" "plain" "plainer")")"
out=$(prompt RV "/forge:change rename plain to plainer"); expect "I: /forge:change lifts review mode" "$out" 'change mode'
allowed "I good: edit allowed after /forge:change" "$(pre RV Edit "$(edit "$R/src/fmt.mjs" "plain" "plainer")")"

# ---- S/H without any forge task or contract: recorded only ----
allowed "observe: no task, new dep is only recorded" "$(pre FREE Bash "$(bash_ 'npm install left-pad')")"
out=$($FORGE guard --session FREE); expect "observe: decision is in the guard log" "$out" 'DEPENDENCY_NOT_AUTHORIZED/observe'

# ---- S: small task, plan boundary + dependencies + hashing ----
$FORGE new GD-1 --mode small --title "money formatter" >/dev/null
cat > $TMPDIR/guard-plan.json <<'EOF'
{"steps":["add money()"],"files":["src/fmt.mjs"],"tests":["tests/ac2.test.mjs"],"test_cmd":"node --test tests/existing.test.mjs",
 "cases":[{"id":"h","kind":"happy","cmd":"true"},{"id":"u","kind":"unhappy","cmd":"true"},{"id":"e","kind":"edge","cmd":"true"}]}
EOF
$FORGE plan --file $TMPDIR/guard-plan.json >/dev/null
allowed "S good: before BUILD the plan boundary is not enforced" "$(pre S1 Edit "$(edit "$R/src/price.mjs" "WORK" "WORK")")"
$FORGE phase BUILD >/dev/null
allowed "S good: file in the plan" "$(pre S1 Edit "$(edit "$R/src/fmt.mjs" "plain" "plain")")"
allowed "S good: test file listed in plan.tests" "$(pre S1 Edit "$(edit "$R/tests/ac2.test.mjs" "ac2" "ac2")")"
out=$(pre S1 Edit "$(edit "$R/src/price.mjs" "WORK" "WORK")"); expect "S bad: file outside the plan denied" "$out" 'not in the plan'
allowed "S good: forge state is not product code" "$(pre S1 Write '{"file_path":"'$R'/.forge/notes.md","content":"x"}')"
out=$(pre S1 Bash "$(bash_ 'npm install left-pad')"); expect "S bad: new dependency asks the owner" "$out" '"permissionDecision":"ask"'
allowed "S good: npm install that restores is not a new dep" "$(pre S1 Bash "$(bash_ 'npm install')")"
out=$(pre S1 Edit "$(edit "$R/src/fmt.mjs" "export function plain" "import { createHash } from 'node:crypto'\nexport const sum = (s) => createHash('sha256').update(s).digest('hex')\nexport function plain")"); expect "H bad: new hashing asks the owner" "$out" 'adds hashing'
node -e 'const f=process.argv[1],p=require(f);p.allow={deps:["left-pad"],hash:true};p.files.push("package.json");require("fs").writeFileSync(f,JSON.stringify(p))' "$R/.forge/tasks/GD-1/plan.json"
allowed "S good: dependency allowed by plan.allow" "$(pre S1 Bash "$(bash_ 'npm install left-pad')")"
out=$(pre S1 Bash "$(bash_ 'npm install left-pad lodash')"); expect "S bad: allow list covers only named deps" "$out" 'lodash'
allowed "H good: hashing allowed by plan.allow" "$(pre S1 Edit "$(edit "$R/src/fmt.mjs" "export function plain" "import { createHash } from 'node:crypto'\nexport function plain")")"

# ---- T: thrash in the small harness ----
stop() { echo "{\"cwd\":\"$R\",\"session_id\":\"S1\",\"stop_hook_active\":false}" | $FORGE hook stop; }
$FORGE stop >/dev/null
$FORGE new GD-2 --mode small --title "always red" >/dev/null
echo '{"files":["src/x.mjs"],"test_cmd":"node -e \"process.exit(require(\\\"fs\\\").existsSync(\\\"src/x.mjs\\\")?0:1)\"","cases":[{"id":"h","kind":"happy","cmd":"test -f src/x.mjs"},{"id":"u","kind":"unhappy","cmd":"true"},{"id":"e","kind":"edge","cmd":"true"}]}' | $FORGE plan --stdin >/dev/null
$FORGE phase BUILD >/dev/null
out=$(stop); expect "T: first red run spends revision 1" "$out" 'revision 1/3'
out=$(stop); expect "T bad: unchanged workspace does not re-run the tests" "$out" 'nothing changed since the last red run'
out=$($FORGE status); expect "T: no revision was spent on the thrash" "$out" '"revisions": "1/3"'
out=$(stop); expect "T bad: second unchanged turn escalates" "$out" 'has not changed since the last red run, twice'
out=$(stop); allowed "T: escalated task no longer blocks" "$out"
$FORGE new GD-3 --mode small --title "progress" >/dev/null
echo '{"files":["src/x.mjs"],"test_cmd":"test -f src/x.mjs","cases":[{"id":"h","kind":"happy","cmd":"test -f src/x.mjs"},{"id":"u","kind":"unhappy","cmd":"true"},{"id":"e","kind":"edge","cmd":"true"}]}' | $FORGE plan --stdin >/dev/null
$FORGE phase BUILD >/dev/null
echo "{\"cwd\":\"$R\",\"session_id\":\"S3\",\"stop_hook_active\":false}" | $FORGE hook stop >/dev/null
echo 'export const x = 1' > src/x.mjs
out=$(echo "{\"cwd\":\"$R\",\"session_id\":\"S3\",\"stop_hook_active\":false}" | $FORGE hook stop); expect "T good: a real change re-runs the tests (green)" "$out" 'Task GD-3 is DONE'
rm -f src/x.mjs

# ---- lane: dependency and hashing denied, a finding is the way out ----
mkdir -p $R/lanewt/src && echo '{"lane":"a","key":"BIG","role":"lane","owns":["src/**","package.json"],"locked":["tests/**"],"allow":{"deps":["zod"]}}' > $R/lanewt/.forge-lane
cp src/fmt.mjs $R/lanewt/src/fmt.mjs; echo '{"name":"x","dependencies":{}}' > $R/lanewt/package.json
lane() { node -e 'const [a,b,c]=process.argv.slice(1);console.log(JSON.stringify({cwd:a,tool_name:b,tool_input:JSON.parse(c)}))' "$R/lanewt" "$@" | $FORGE hook pretooluse; }
out=$(lane Bash "$(bash_ 'npm install axios')"); expect "lane bad: unlisted dependency denied" "$out" '"permissionDecision":"deny"'
expect "lane: deny tells the lane to file a finding" "$out" 'forge finding --kind dependency'
allowed "lane good: dependency listed in goal.allow" "$(lane Bash "$(bash_ 'npm install zod')")"
out=$(lane Write '{"file_path":"'$R'/lanewt/package.json","content":"{\"name\":\"x\",\"dependencies\":{\"axios\":\"1\"}}"}'); expect "lane bad: manifest edit adding a dep denied" "$out" 'axios'
out=$(lane Edit "$(edit "$R/lanewt/src/fmt.mjs" "export function plain" "const crypto = require('crypto')\nconst d = crypto.createHash('md5')\nexport function plain")"); expect "lane bad: hashing denied" "$out" 'adds hashing'

out=$($FORGE guard); expect "guard log counts rules" "$out" 'PATH_OUTSIDE_PLAN/deny'
expect "guard log has thrash" "$out" 'TASK_THRASH'
rm -rf "$R/lanewt"
[ $FAIL = 0 ] && echo "E2E guard: ALL PASS" || { echo "E2E guard: FAILURES"; exit 1; }
