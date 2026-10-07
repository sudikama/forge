#!/usr/bin/env bash
# E2E: the full large-task flow through the forge CLI on the fixture repo, with the scripted
# stub agent in place of claude -p. Asserts the gates, the loop outcome, the report and learning.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FORGE="node $HERE/../../bin/forge.mjs"
export FORGE_HOME=${TMPDIR:-/tmp}/forge-e2e/home
rm -rf "$FORGE_HOME"; mkdir -p "$FORGE_HOME"
R=$(bash "$HERE/make-fixture.sh")
cd "$R"
FAIL=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAIL=1; }
expect() { if echo "$2" | grep -q -- "$3"; then pass "$1"; else fail "$1 (wanted: $3)"; echo "$2" | tail -5; fi; }

out=$($FORGE new SHOP-1 --mode large --title "tax + money formatting + USD" 2>&1); expect "report target is mandatory" "$out" "report-to is required"
$FORGE new SHOP-1 --mode large --title "tax + money formatting + USD" --report-to file >/dev/null
TD=$R/.forge/tasks/SHOP-1
out=$($FORGE check); expect "gate INTAKE: needs a source" "$out" '"state": "INTAKE"'

cat > /tmp/forge-e2e-ticket.md <<'EOF'
# SHOP-1: tax, money formatting, USD
- AC1: totalWithTax(items, rate); negative rate rejected; empty cart is 0
- AC2: money(n) formats rupiah "Rp 1.234,50"; NaN rejected
- AC3: toUSD(idr)
- also: total() is too slow for big carts
EOF
$FORGE source add --kind jira --ref SHOP-1 --stdin < /tmp/forge-e2e-ticket.md >/dev/null
out=$($FORGE check); expect "gate SPEC: goal+spec missing" "$out" '"state": "SPEC"'

cat > $TD/goal.json <<'EOF'
{ "objective": "AC-1..3 implemented, total() linear",
  "test_cmd": "node --test tests/*.test.mjs", "regression_cmd": "node --test tests/existing.test.mjs",
  "metric": { "name": "total() work units for 1000 items", "cmd": "node bench/work.mjs", "direction": "min", "target": 2000 },
  "budget": { "max_iterations": 6, "max_minutes": 20, "plateau_n": 3, "lane_max_turns": 30, "lane_timeout_min": 5 },
  "editable": ["src/**"], "locked": ["tests/**", "bench/**"] }
EOF
cat > $TD/spec.md <<'EOF'
# Spec SHOP-1
## Problem
No tax total, no rupiah formatting, no USD; total() is quadratic (source: SHOP-1#desc).
## Goals
Ship AC-1..3 and make total() linear.
## Non-goals
Changing report.mjs output.
## Requirements
- MUST keep qty default 1 and same-object dedupe in total() (source: tests/existing.test.mjs)
## Acceptance Criteria
- [ ] AC-1: totalWithTax(items, rate) returns total*(1+rate) rounded to cents; negative rate throws RangeError; empty cart is 0 (source: SHOP-1#desc)
- [ ] AC-2: money(n) returns "Rp 1.234,50" style; NaN throws TypeError; 0 and negatives handled (source: SHOP-1#desc)
- [ ] AC-3: toUSD(idr) formats USD (source: SHOP-1#desc)
## Test Seams
node --test tests/ac*.test.mjs
## Edge Cases
empty cart, zero, negative amounts, NaN
## Constraints
public exports of price.mjs/fmt.mjs stay compatible
## Open Questions
- none
## Task Breakdown
W1 price, W2 fmt, W3 currency
## Assumptions
none
EOF
out=$($FORGE check); expect "gate SCOPED: scope missing" "$out" '"state": "SCOPED"'

cat > $TD/scope.json <<'EOF'
{ "in_scope": [
    { "path": "src/price.mjs", "ac": ["AC-1"], "evidence": "src/price.mjs:3 total()" },
    { "path": "src/fmt.mjs", "ac": ["AC-2"], "evidence": "src/fmt.mjs:1 plain()" },
    { "path": "src/currency.mjs", "ac": ["AC-3"], "new": true } ],
  "impacted": [ { "path": "src/report.mjs", "evidence": "src/report.mjs:2 calls total()", "tests": ["tests/existing.test.mjs"] } ],
  "out_of_scope": [ { "item": "report.mjs formatting", "why": "Non-goal" } ],
  "conflicts": [] }
EOF
cat > $TD/worklist.json <<'EOF'
{ "items": [
  { "id": "W1", "title": "totalWithTax + linear total", "ac": ["AC-1"], "size": "M", "writes": ["src/price.mjs"] },
  { "id": "W2", "title": "money()", "ac": ["AC-2"], "size": "S", "writes": ["src/fmt.mjs"] },
  { "id": "W3", "title": "toUSD()", "ac": ["AC-3"], "size": "S", "writes": ["src/currency.mjs"], "depends_on": ["W2"] } ] }
EOF
cat > $TD/matrix.json <<'EOF'
{ "cases": [
  { "id": "AC1-happy", "kind": "happy", "source": "AC-1", "items": ["W1"], "expect": "222", "cmd": "node --test --test-name-pattern='ac1 happy' tests/ac1.test.mjs" },
  { "id": "AC1-unhappy", "kind": "unhappy", "source": "AC-1", "items": ["W1"], "expect": "RangeError", "cmd": "node --test --test-name-pattern='ac1 unhappy' tests/ac1.test.mjs" },
  { "id": "AC1-edge", "kind": "edge", "source": "AC-1", "items": ["W1"], "expect": "0", "cmd": "node --test --test-name-pattern='ac1 edge' tests/ac1.test.mjs" },
  { "id": "AC2-happy", "kind": "happy", "source": "AC-2", "items": ["W2"], "expect": "Rp 1.234,50", "cmd": "node --test --test-name-pattern='ac2 happy' tests/ac2.test.mjs" },
  { "id": "AC2-unhappy", "kind": "unhappy", "source": "AC-2", "items": ["W2"], "expect": "TypeError", "cmd": "node --test --test-name-pattern='ac2 unhappy' tests/ac2.test.mjs" },
  { "id": "AC2-edge", "kind": "edge", "source": "AC-2", "items": ["W2"], "expect": "0 and negative", "cmd": "node --test --test-name-pattern='ac2 edge' tests/ac2.test.mjs" },
  { "id": "AC3-happy", "kind": "happy", "source": "AC-3", "items": ["W3"], "expect": "$1.00", "cmd": "node --test tests/ac3.test.mjs" },
  { "id": "R-report", "kind": "regression", "covers": ["src/report.mjs"], "expect": "existing suite green", "cmd": "node --test tests/existing.test.mjs" } ],
  "waivers": [ { "ac": "AC-3", "kind": "unhappy", "reason": "blocked pending rate source" }, { "ac": "AC-3", "kind": "edge", "reason": "blocked pending rate source" } ] }
EOF
out=$($FORGE check); expect "gate PLANNED: lanes+baseline missing" "$out" 'lanes\] not computed'

out=$($FORGE lanes); expect "lanes: 3 collision-free clusters" "$out" '3 items in 3 collision-free clusters'
echo "$out" | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("  recommended",l.recommended_workers,"caps",JSON.stringify(l.caps),"lanes",JSON.stringify(l.lanes.map(x=>[x.lane,x.items,x.owns])))'
out=$($FORGE baseline); expect "baseline: metric measured" "$out" '"metric": 499500'
expect "baseline: regression green, no issues" "$out" '"issues": \[\]'
out=$($FORGE check); expect "gate CLARIFY: questions not generated" "$out" '"state": "CLARIFY"'

$FORGE clarify > $TD/clarify.txt
grep -q "E1. Parallel workers: recommend" $TD/clarify.txt && pass "clarify asks the worker count" || fail "clarify asks the worker count"
out=$($FORGE lock --approve 2>&1); expect "lock refused while questions are open" "$out" 'cannot lock'
for id in $(node -e 'const c=require(process.argv[1]);console.log(c.questions.map(q=>q.id).join(" "))' $TD/clarify.json); do
  ans=$(node -e 'const c=require(process.argv[1]);const q=c.questions.find(x=>x.id===process.argv[2]);console.log(q.recommendation)' $TD/clarify.json $id)
  [ "$id" = "E1" ] && ans=2
  $FORGE answer "$id" "$ans" >/dev/null
done
out=$($FORGE lock 2>&1); expect "lock needs explicit owner approval" "$out" "needs the owner's approval"
out=$($FORGE lock --approve); expect "spec lock" "$out" '"locked": true'
expect "lock hashes evaluator files" "$out" 'tests/ac1.test.mjs'

# Gate: in the session, a locked file cannot be edited once the spec is locked.
out=$(echo "{\"cwd\":\"$R\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/tests/existing.test.mjs\"}}" | $FORGE hook pretooluse)
expect "PreToolUse denies locked test edit (session)" "$out" '"permissionDecision":"deny"'
out=$(echo "{\"cwd\":\"$R\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$R/src/price.mjs\"}}" | $FORGE hook pretooluse)
[ "$out" = "{}" ] && pass "PreToolUse allows editable file" || fail "PreToolUse allows editable file: $out"

export FORGE_AGENT_CMD="node $HERE/stub-agent.mjs"
export FORGE_JEV_LANES=mock,zen FORGE_JEV_MOCK=$HERE/jev-mock.mjs
out=$($FORGE run --foreground 2>&1); echo "$out" | tail -12
expect "loop ends ESCALATED (W3 blocked)" "$out" '"state": "ESCALATED"'
expect "stop reason" "$out" 'every remaining item is blocked'

cat $TD/results.tsv
it=$(cat $TD/iterations.json)
node -e '
const it=require(process.argv[1]);const ok=(n,c)=>console.log((c?"PASS ":"FAIL ")+n)
ok("iter1 discarded for regression R-report", it[0].verdict==="discard" && it[0].regressions.includes("R-report"))
ok("iter1 recorded the caught regression", (it[0].caught||[]).some(c=>c.id==="R-report"))
ok("iter2 lane b rejected for touching a locked file", it[1].lanes.some(l=>/REJECTED, touched locked files tests\/existing/.test(l)))
ok("iter2 kept (W1 green, metric down)", it[1].verdict==="keep" && it[1].metric<=2000)
ok("iter3 kept (W2 green)", it[2].verdict==="keep" && it[2].ac==="6/7")
const small=(r)=>r.items.every(i=>i!=="W1")
const r1=it[0].routes.find(small), r1a=it[0].routes.find(r=>r.items.includes("W1"))
ok("routing: iter1 small-slice lane on haiku/low via jev", r1 && r1.model==="haiku" && r1.effort==="low" && r1.source==="jev:mock")
ok("routing: W1 lane starts on Sonnet 5.5", r1a && r1a.model==="claude-sonnet-5-5")
const r2=it[1].routes.find(small)
ok("ladder: iter1 regression blamed on W1 alone (isolated re-run), a retry on sonnet", (it[0].ladder||[]).some(e=>e.kind==="retry" && e.item==="W1" && e.tier==="balanced" && /red on this lane alone/.test(e.why)))
ok("ladder: W2 green on haiku in a discarded iteration is not counted", !(it[0].ladder||[]).some(e=>e.item==="W2") && r2 && r2.model==="haiku")
ok("ladder: W2 rejected on haiku in iter2 escalates at once to Sonnet 5.5", (it[1].ladder||[]).some(e=>e.kind==="escalate" && e.item==="W2" && e.from==="fast" && e.to==="balanced"))
const r3=it[2].routes.find(small)
ok("ladder: iter3 W2 runs on Sonnet 5.5 and passes", r3 && r3.model==="claude-sonnet-5-5" && /ladder balanced/.test(r3.why) && it[2].verdict==="keep")
' $TD/iterations.json | tee -a /tmp/forge-e2e-asserts; grep -q FAIL /tmp/forge-e2e-asserts 2>/dev/null && FAIL=1; rm -f /tmp/forge-e2e-asserts

f=$($FORGE findings)
TD=$TD node -e '
const f=JSON.parse(require("fs").readFileSync(0,"utf8"));const by=k=>f.find(x=>x.kind===k);const ok=(n,c)=>console.log((c?"PASS ":"FAIL ")+n)
ok("spec_gap decided by orchestrator with a valid cite", by("spec_gap")?.status==="decided" && /^spec\.md:L\d+$/.test(by("spec_gap").decision.cite))
ok("ambiguity with invalid cite auto-BLOCKED", by("ambiguity")?.status==="blocked" && by("ambiguity").decision.invalid===true)
ok("preexisting bug noted as ticket proposal", by("preexisting_bug")?.status==="noted")
ok("locked-file touch auto-rejected by policy, not BLOCKED", by("lock_violation")?.status==="rejected")
const o=by("other"); const ng=require("fs").readFileSync(process.env.TD+"/spec.md","utf8").split("\n").findIndex(l=>/Changing report.mjs output/.test(l))+1
ok("jev rejects the non-goal finding itself, citing the Non-goals line", o?.status==="rejected" && o.decision.by==="jev" && o.decision.cite==="spec.md:L"+ng)
ok("orchestrator agent was never spawned for the jev-rejected finding", !require("fs").readdirSync(process.env.TD+"/agents").some(f=>f.includes("orchestrator-"+o?.id)))
const sg=by("spec_gap")
ok("orchestrator routed, never below sonnet", sg?.route?.model==="claude-sonnet-5-5")
' <<< "$f" | tee /tmp/forge-e2e-asserts2; grep -q FAIL /tmp/forge-e2e-asserts2 && FAIL=1; rm -f /tmp/forge-e2e-asserts2

rep=$(cat $TD/report.md)
expect "report lists BLOCKED with question options" "$rep" 'options: fixed 16000 | env var | API'
expect "report proposes new ticket" "$rep" 'report.line ignores currency formatting'
expect "report shows W3 blocked" "$rep" 'W3 \[blocked\]'
expect "report metric curve" "$rep" 'baseline 499500'
expect "report shows model routing" "$rep" 'Model routing per iteration'
expect "report shows the model ladder" "$rep" 'W2: now balanced; attempts iter 1 haiku not counted, iter 2 haiku FAIL, iter 3 claude-sonnet-5-5 pass'
expect "report attributes the jev decision" "$rep" 'rejected by jev'
expect "results.tsv has a routes column" "$(head -1 $TD/results.tsv)" 'routes'
expect "lane agent received its routed model" "$(cat $TD/agents/0001-lane-*.log)" 'model=haiku effort=low'

# Learning: the regression that was caught becomes a repo instinct and shows up in the next task's clarify.
out=$($FORGE learn list); expect "instinct captured from run evidence" "$out" 'regression:R-report'
$FORGE new SHOP-2 --mode large --title next --report-to file >/dev/null
cp $TD/{goal.json,spec.md,scope.json,worklist.json,matrix.json} $R/.forge/tasks/SHOP-2/
$FORGE source add --kind markdown --file /tmp/forge-e2e-ticket.md >/dev/null
$FORGE lanes >/dev/null; $FORGE baseline --force >/dev/null
out=$($FORGE clarify); expect "next task's clarify shows the learned instinct" "$out" 'J1. Learned instincts'

# Ladder: W2 broken by every model. Limits 1/1/1 keep it short: haiku -> sonnet -> opus -> BLOCKED.
$FORGE new SHOP-3 --mode large --title ladder --report-to file >/dev/null
cp $TD/{goal.json,spec.md,scope.json,worklist.json,matrix.json} $R/.forge/tasks/SHOP-3/
$FORGE source add --kind markdown --file /tmp/forge-e2e-ticket.md >/dev/null
$FORGE lanes >/dev/null; $FORGE baseline --force >/dev/null; $FORGE clarify >/dev/null
T3=$R/.forge/tasks/SHOP-3
for id in $(node -e 'const c=require(process.argv[1]);console.log(c.questions.map(q=>q.id).join(" "))' $T3/clarify.json); do
  ans=$(node -e 'const c=require(process.argv[1]);const q=c.questions.find(x=>x.id===process.argv[2]);console.log(q.recommendation)' $T3/clarify.json $id)
  [ "$id" = "E1" ] && ans=2
  $FORGE answer "$id" "$ans" >/dev/null
done
$FORGE lock --approve >/dev/null
out=$(FORGE_STUB_MODE=w2-always-broken FORGE_LADDER_FAILS_BALANCED=1 FORGE_LADDER_FAILS_DEEP=1 $FORGE run --foreground 2>&1)
expect "ladder run ends with W2 blocked" "$out" 'every remaining item is blocked'
FORGE_LADDER_FAILS_BALANCED=1 FORGE_LADDER_FAILS_DEEP=1 node -e '
const it=require(process.argv[1]+"/iterations.json");const fs=require("fs");const ok=(n,c)=>console.log((c?"PASS ":"FAIL ")+n)
const w2=it.map(i=>(i.routes||[]).find(r=>r.items.includes("W2"))).filter(Boolean).map(r=>r.model)
ok("ladder: W2 ran haiku, then Sonnet 5.5, then Opus 5.5 ("+w2.join(" > ")+")", w2.join(",")==="haiku,claude-sonnet-5-5,claude-opus-5-5")
const fd=fs.readdirSync(process.argv[1]+"/findings").map(f=>JSON.parse(fs.readFileSync(process.argv[1]+"/findings/"+f)))
const ex=fd.find(f=>/after every model tier/.test(f.title))
ok("ladder exhausted: BLOCKED finding with every attempt as evidence", ex && ex.status==="blocked" && ex.item==="W2" && /haiku failed.*claude-sonnet-5-5 failed.*claude-opus-5-5 failed/.test(ex.evidence))
const st=JSON.parse(fs.readFileSync(process.argv[1]+"/worklist-state.json")).items
ok("ladder: W1 done, W2 blocked by the ladder finding", st.find(i=>i.id==="W1").status==="done" && st.find(i=>i.id==="W2").status==="blocked" && st.find(i=>i.id==="W2").blocked_by===ex?.id)
const rep=fs.readFileSync(process.argv[1]+"/report.md","utf8")
ok("ladder: report lists it under BLOCKED with options", /still fails the gate after every model tier/.test(rep) && /clarify or split the item/.test(rep))
' $T3 | tee /tmp/forge-e2e-asserts3; grep -q FAIL /tmp/forge-e2e-asserts3 && FAIL=1; rm -f /tmp/forge-e2e-asserts3

# The loop never touched the base branch.
[ "$(git -C $R rev-parse --abbrev-ref HEAD)" = "main" ] && [ "$(git -C $R log --oneline main | wc -l)" = "1" ] && pass "base branch untouched (forge never merges)" || fail "base branch untouched"
echo; [ $FAIL = 0 ] && echo "E2E: ALL PASS" || echo "E2E: FAILURES"
exit $FAIL
