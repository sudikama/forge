#!/usr/bin/env bash
# E2E: the full large-task flow through the forge CLI on the fixture repo, with the scripted
# stub agent in place of claude -p. Asserts the gates, the loop outcome, the report and learning.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FORGE="node $HERE/../../bin/forge.mjs"
export FORGE_HOME=$HOME/.hermes/cache/scratch/forge-e2e/home
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
' $TD/iterations.json | tee -a /tmp/forge-e2e-asserts; grep -q FAIL /tmp/forge-e2e-asserts 2>/dev/null && FAIL=1; rm -f /tmp/forge-e2e-asserts

f=$($FORGE findings)
node -e '
const f=JSON.parse(require("fs").readFileSync(0,"utf8"));const by=k=>f.find(x=>x.kind===k);const ok=(n,c)=>console.log((c?"PASS ":"FAIL ")+n)
ok("spec_gap decided by orchestrator with a valid cite", by("spec_gap")?.status==="decided" && /^spec\.md:L\d+$/.test(by("spec_gap").decision.cite))
ok("ambiguity with invalid cite auto-BLOCKED", by("ambiguity")?.status==="blocked" && by("ambiguity").decision.invalid===true)
ok("preexisting bug noted as ticket proposal", by("preexisting_bug")?.status==="noted")
ok("locked-file touch auto-rejected by policy, not BLOCKED", by("lock_violation")?.status==="rejected")
' <<< "$f" | tee /tmp/forge-e2e-asserts2; grep -q FAIL /tmp/forge-e2e-asserts2 && FAIL=1; rm -f /tmp/forge-e2e-asserts2

rep=$(cat $TD/report.md)
expect "report lists BLOCKED with question options" "$rep" 'options: fixed 16000 | env var | API'
expect "report proposes new ticket" "$rep" 'report.line ignores currency formatting'
expect "report shows W3 blocked" "$rep" 'W3 \[blocked\]'
expect "report metric curve" "$rep" 'baseline 499500'

# Learning: the regression that was caught becomes a repo instinct and shows up in the next task's clarify.
out=$($FORGE learn list); expect "instinct captured from run evidence" "$out" 'regression:R-report'
$FORGE new SHOP-2 --mode large --title next --report-to file >/dev/null
cp $TD/{goal.json,spec.md,scope.json,worklist.json,matrix.json} $R/.forge/tasks/SHOP-2/
$FORGE source add --kind markdown --file /tmp/forge-e2e-ticket.md >/dev/null
$FORGE lanes >/dev/null; $FORGE baseline --force >/dev/null
out=$($FORGE clarify); expect "next task's clarify shows the learned instinct" "$out" 'J1. Learned instincts'

# The loop never touched the base branch.
[ "$(git -C $R rev-parse --abbrev-ref HEAD)" = "main" ] && [ "$(git -C $R log --oneline main | wc -l)" = "1" ] && pass "base branch untouched (forge never merges)" || fail "base branch untouched"
echo; [ $FAIL = 0 ] && echo "E2E: ALL PASS" || echo "E2E: FAILURES"
exit $FAIL
