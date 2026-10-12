#!/usr/bin/env bash
# E2E small harness + lane gate: drives the real hook entry points with Claude Code's hook JSON.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FORGE="node $HERE/../../bin/forge.mjs"
export FORGE_HOME=${TMPDIR:-/tmp}/forge-e2e/home-small
rm -rf "$FORGE_HOME"; mkdir -p "$FORGE_HOME"
R=$(bash "$HERE/make-fixture.sh" ${TMPDIR:-/tmp}/forge-e2e/small)
cd "$R"
FAIL=0
expect() { if echo "$2" | grep -q -- "$3"; then echo "PASS $1"; else echo "FAIL $1 (wanted: $3)"; echo "$2" | head -8; FAIL=1; fi; }
stop() { echo "{\"cwd\":\"$R\",\"session_id\":\"S1\",\"stop_hook_active\":false}" | $FORGE hook stop; }

$FORGE new FIX-1 --mode small --title "money() rupiah formatter" >/dev/null
out=$(stop); expect "Stop blocks while PLAN is incomplete" "$out" '"decision":"block".*PLAN is not complete'
out=$(echo '{"files":["src/fmt.mjs"],"test_cmd":"node --test tests/existing.test.mjs tests/ac2.test.mjs","cases":[{"id":"h","kind":"happy","cmd":"node --test --test-name-pattern=\"ac2 happy\" tests/ac2.test.mjs"}]}' | $FORGE plan --stdin)
out=$($FORGE phase BUILD 2>&1); expect "BUILD refused without unhappy/edge cases" "$out" 'no unhappy case'
cat > /tmp/forge-small-plan.json <<'EOF'
{"steps":["add money()"],"files":["src/fmt.mjs"],"test_cmd":"node --test tests/existing.test.mjs tests/ac2.test.mjs",
 "cases":[{"id":"h","kind":"happy","cmd":"node --test --test-name-pattern='ac2 happy' tests/ac2.test.mjs"},
          {"id":"u","kind":"unhappy","cmd":"node --test --test-name-pattern='ac2 unhappy' tests/ac2.test.mjs"},
          {"id":"e","kind":"edge","cmd":"node --test --test-name-pattern='ac2 edge' tests/ac2.test.mjs"}]}
EOF
$FORGE plan --file /tmp/forge-small-plan.json >/dev/null
out=$($FORGE phase BUILD); expect "BUILD allowed with happy+unhappy+edge" "$out" '"phase": "BUILD"'

# Revision 1: a half-done implementation (no NaN check, no negatives) is red, Stop blocks with failures.
cat > src/fmt.mjs <<'EOF'
export function plain(n) { return String(n) }
export function money(n) { const [i, d] = n.toFixed(2).split('.'); return 'Rp ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d }
EOF
out=$(stop); expect "Stop re-prompts on red tests (revision 1/3)" "$out" 'TEST is red (revision 1/3)'
expect "re-prompt names the failing unhappy case" "$out" 'u (unhappy)'
out=$(echo "{\"cwd\":\"$R\",\"session_id\":\"OTHER\"}" | $FORGE hook stop); [ "$out" = "{}" ] && echo "PASS other session in the same repo is not hijacked" || { echo "FAIL other session hijacked: $out"; FAIL=1; }

# Revision 2: correct implementation, Stop lets go with DONE.
cat > src/fmt.mjs <<'EOF'
export function plain(n) { return String(n) }
export function money(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) throw new TypeError('money() needs a number')
  const [i, d] = Math.abs(n).toFixed(2).split('.')
  return (n < 0 ? '-' : '') + 'Rp ' + i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + d
}
EOF
out=$(stop); expect "Stop lets the turn end when green" "$out" 'Task FIX-1 is DONE'
out=$(stop); [ "$out" = "{}" ] && echo "PASS no more blocking after DONE" || { echo "FAIL still blocking: $out"; FAIL=1; }
# After DONE the push guard must let go (regression: state stayed RUNNING and blocked git push).
pt() { echo "{\"cwd\":\"$R\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$1\"}}" | $FORGE hook pretooluse; }
out=$(node -e 'console.log(require(process.argv[1]).state)' "$R/.forge/tasks/FIX-1/task.json"); [ "$out" = "DONE" ] && echo "PASS small task state is DONE when the phase is DONE" || { echo "FAIL small task state is $out"; FAIL=1; }
out=$(pt "git push origin HEAD"); [ "$out" = "{}" ] && echo "PASS git push allowed after the small task is DONE" || { echo "FAIL push still denied: $out"; FAIL=1; }
# A task.json written by forge < 0.4.3 (state RUNNING, phase DONE) is healed on read.
node -e 'const f=process.argv[1],j=require(f);j.state="RUNNING";require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "$R/.forge/tasks/FIX-1/task.json"
out=$(pt "git push origin HEAD"); [ "$out" = "{}" ] && echo "PASS legacy RUNNING+DONE task does not block push" || { echo "FAIL legacy task blocks push: $out"; FAIL=1; }
out=$($FORGE status); expect "status reports the healed small task" "$out" '"phase": "DONE"'
out=$($FORGE learn list); expect "small task taught the test command" "$out" 'node --test tests/existing.test.mjs'

# Escalation after the revision cap.
$FORGE new FIX-2 --mode small --title "always red" >/dev/null
echo '{"files":["src/x.mjs"],"test_cmd":"false","cases":[{"id":"h","kind":"happy","cmd":"false"},{"id":"u","kind":"unhappy","cmd":"true"},{"id":"e","kind":"edge","cmd":"true"}]}' | $FORGE plan --stdin >/dev/null
$FORGE phase BUILD >/dev/null
for i in 1 2 3; do stop >/dev/null; done
out=$(stop); expect "escalates after 3 revisions instead of looping" "$out" 'still red after 3 revisions'

# forge stop ends a small task at once and the Stop hook stops driving it.
$FORGE new FIX-3 --mode small --title "abandon me" >/dev/null
out=$($FORGE stop); expect "forge stop ends a small task" "$out" '"state": "STOPPED"'
out=$(stop); [ "$out" = "{}" ] && echo "PASS Stop hook ignores a stopped small task" || { echo "FAIL stopped task still driven: $out"; FAIL=1; }

# Large task: push is denied only while a runner process is really alive.
$FORGE new BIG-1 --mode large --title big --report-to file >/dev/null
setrun() { node -e 'const f=process.argv[1],j=require(f);j.state="RUNNING";j.runner_pid=Number(process.argv[2]);require("fs").writeFileSync(f,JSON.stringify(j,null,2))' "$R/.forge/tasks/BIG-1/task.json" "$1"; }
sleep 30 & LIVE=$!
setrun $LIVE
out=$(pt "git push origin HEAD"); expect "push denied while the loop runner is alive" "$out" 'is running a loop'
kill $LIVE; wait $LIVE 2>/dev/null
out=$(pt "git push origin HEAD"); [ "$out" = "{}" ] && echo "PASS push allowed once the runner is dead" || { echo "FAIL push denied with a dead runner: $out"; FAIL=1; }
out=$($FORGE stop); expect "forge stop finishes a loop whose runner died" "$out" '"state": "STOPPED"'

# Lane gate: inside a worktree marked as lane a, ownership + locks + git are enforced.
mkdir -p $R/lanewt && echo '{"lane":"a","role":"lane","owns":["src/price.mjs"],"locked":["tests/**","bench/**"]}' > $R/lanewt/.forge-lane
g() { echo "{\"cwd\":\"$R/lanewt\",\"tool_name\":\"$1\",\"tool_input\":$2}" | $FORGE hook pretooluse; }
out=$(g Edit "{\"file_path\":\"$R/lanewt/src/price.mjs\"}"); [ "$out" = "{}" ] && echo "PASS lane may edit its own file" || { echo "FAIL own file: $out"; FAIL=1; }
out=$(g Write "{\"file_path\":\"$R/lanewt/src/fmt.mjs\"}"); expect "lane denied outside its files" "$out" "outside lane a's files"
out=$(g Edit "{\"file_path\":\"$R/lanewt/tests/existing.test.mjs\"}"); expect "lane denied on locked test" "$out" 'is locked'
out=$(g Bash '{"command":"git commit -am wip"}'); expect "lane denied git history ops" "$out" 'lanes never touch git history'
out=$(g Bash '{"command":"rm -rf ~ "}'); expect "irreversible command denied" "$out" 'recursive delete'
out=$(g Bash '{"command":"node --test tests/"}'); [ "$out" = "{}" ] && echo "PASS lane may run tests" || { echo "FAIL tests: $out"; FAIL=1; }

# Prompt triage hook (live Jev on zen).
p() { node -e 'console.log(JSON.stringify({cwd:process.argv[1],prompt:process.argv[2],session_id:"S9"}))' "$R" "$1" | $FORGE hook prompt; }
rm -f $R/.forge/active
out=$(p "apa bedanya useEffect dan useLayoutEffect di React, tolong jelaskan singkat ya"); [ "$out" = "{}" ] && echo "PASS question is not triaged as work" || { echo "FAIL question triaged: $out"; FAIL=1; }
out=$(p "tambahkan fungsi money() di src/fmt.mjs untuk format rupiah, lengkap dengan unit test"); expect "small request goes to the small harness" "$out" 'SMALL task'
out=$(p "migrasi seluruh backend Express ke Go termasuk auth, payment gateway, worker antrian dan CI pipeline, sesuai PRD terlampir"); expect "large request goes to the big loop" "$out" 'LARGE task'
out=$(p "tolong bikin aplikasinya jadi lebih bagus dan lebih enak dipakai ya"); expect "vague request goes to clarify first" "$out" 'too vague'
echo; [ $FAIL = 0 ] && echo "E2E small: ALL PASS" || echo "E2E small: FAILURES"
exit $FAIL
