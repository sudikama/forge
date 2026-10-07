// Clarify: one numbered batch of DECISIONS (never facts the repo can answer), each with a
// recommendation. Generated deterministically from the artifacts so nothing is forgotten;
// Claude presents them in-session (AskUserQuestion) and records answers with `forge answer`.
import { readArt, specACs } from './task.mjs'

export function build(t, { lanePlan, base, instincts }) {
  const goal = readArt(t, 'goal.json', {})
  const scope = readArt(t, 'scope.json', { in_scope: [], impacted: [], out_of_scope: [], conflicts: [] })
  const spec = readArt(t, 'spec.md', '')
  const wl = readArt(t, 'worklist.json', { items: [] })
  const prev = readArt(t, 'clarify.json', { questions: [] })
  const old = new Map((prev.questions || []).map((q) => [q.id, q]))
  const qs = []
  const add = (group, id, question, recommendation, options = [], extra = {}) => {
    const keep = old.get(id)
    qs.push({ group, id, question, recommendation, options, answer: keep?.answer ?? null, answered_by: keep?.answered_by, ...extra })
  }
  const m = goal.metric || {}
  const b = goal.budget || {}

  // A. goal and metric
  add('A goal', 'A1', `Metric "${m.name || m.cmd}" ${m.direction === 'min' ? 'down to' : 'up to'} ${m.target}; baseline measured ${base?.metric ?? 'n/a'}. Is this target right?`, `keep ${m.target}`, [`keep ${m.target}`, 'change target'])
  add('A goal', 'A2', 'Guard metrics that must not get worse while the main metric improves (memory, bundle size, p99, cost)?', goal.guards?.length ? `keep: ${goal.guards.map((g) => g.name).join(', ')}` : 'none', ['none', 'add guard'])
  // B. scope
  add('B scope', 'B1', `In scope: ${scope.in_scope.length} paths; impacted (regression targets): ${scope.impacted.length}; out of scope: ${scope.out_of_scope.length}. Approve the scope map (scope.json)?`, 'approve', ['approve', 'edit'])
  for (const c of scope.conflicts || []) add('B scope', `B-${c.id}`, `Spec vs code conflict ${c.id}: ${c.summary || ''} (evidence: ${c.evidence})`, c.recommendation || (c.options || [])[0], c.options || [])
  // C. requirements
  for (const line of (spec.match(/^##+\s*Open Questions\s*$([\s\S]*?)(?=^##\s)/mi)?.[1] || '').split('\n')) {
    const q = line.match(/^\s*-\s*(?:\S+\s+)?(.+\?)\s*$/)
    if (q) add('C requirements', `C-${qs.filter((x) => x.group === 'C requirements').length + 1}`, q[1], (spec.split(q[1])[1] || '').match(/\u2192\s*(.+)/)?.[1] || 'see spec')
  }
  const noSrc = specACs(spec).filter((a) => /assum/i.test(a.source || ''))
  if (noSrc.length) add('C requirements', 'C-assumed', `ACs resting on assumptions, not on a source: ${noSrc.map((a) => a.id).join(', ')}. Confirm them?`, 'confirm', ['confirm', 'drop', 'edit'])
  add('C requirements', 'C-contract', 'May public contracts change (API shapes, DB schema, CLI flags, events)?', 'no: any contract change becomes BLOCKED', ['no', 'yes, listed ones only'])
  // D. testing
  add('D testing', 'D1', `Test command "${goal.test_cmd}", pre-existing suite "${goal.regression_cmd || 'not set'}". Correct?`, 'correct', ['correct', 'change'])
  if (base) {
    for (const i of base.issues || []) add('D testing', `D-${i.id}`, `Baseline: ${i.id}: ${i.issue}`, i.id === 'regression_cmd' ? 'fix before the loop' : 'fix the case before lock', ['fix before lock', 'mark known_red and exclude'])
    if ((base.flaky || []).length) add('D testing', 'D-flaky', `Flaky at baseline: ${base.flaky.join(', ')}. Exclude from the regression comparison?`, 'exclude', ['exclude', 'fix first'])
  }
  const untested = (scope.impacted || []).filter((i) => !(i.tests || []).length)
  if (untested.length) add('D testing', 'D-charac', `Impacted without tests: ${untested.map((i) => i.path).slice(0, 8).join(', ')}${untested.length > 8 ? '...' : ''}. Write characterization tests at the base commit before any change?`, 'yes', ['yes', 'accept the risk'])
  add('D testing', 'D-tests-edit', 'May the loop modify existing test files (not just add new ones)?', 'no: existing tests are locked', ['no', 'only listed files'])
  // E. execution: subagents
  if (lanePlan) {
    const o = lanePlan.options.map((x) => `${x.workers}w makespan ${x.makespan} util ${x.utilization}${x.allowed ? '' : ' (over cap)'}`).join('; ')
    add('E execution', 'E1', `Parallel workers: recommend ${lanePlan.recommended_workers}. ${lanePlan.rationale}. Options: ${o}. Lanes: ${lanePlan.lanes.map((l) => `${l.lane}=[${l.items.join(',')}] owns ${l.owns.slice(0, 4).join(' ')}`).join(' | ')}`, String(lanePlan.recommended_workers), lanePlan.options.filter((x) => x.allowed).map((x) => String(x.workers)))
    if (lanePlan.integrator.owns.length) add('E execution', 'E2', `Shared files owned only by the orchestrator (lanes request changes): ${lanePlan.integrator.owns.slice(0, 8).join(', ')}`, 'approve', ['approve', 'edit'])
    if (lanePlan.collisions.length) add('E execution', 'E3', `${lanePlan.collisions.length} collisions forced items into the same lane (${lanePlan.collisions.slice(0, 4).map((c) => `${c.a}~${c.b}`).join(', ')}). Re-slice them for more parallelism, or accept?`, 'accept', ['accept', 're-slice'])
  }
  add('E execution', 'E4', `Loop branch ${t.loop_branch} from ${String(t.base_commit).slice(0, 8)} (${t.base_branch}). OK?`, 'ok', ['ok', 'change'])
  // F. budget and stop
  add('F budget', 'F1', `Stop rules: target reached OR ${b.max_iterations} iterations OR ${b.max_minutes} minutes OR ${b.plateau_n} iterations without improvement. OK?`, 'ok', ['ok', 'change'])
  add('F budget', 'F2', 'Per-iteration agent turn cap and timeout?', `${b.lane_max_turns || 60} turns, ${b.lane_timeout_min || 30} min`, [])
  // G. authority
  add('G authority', 'G1', 'The orchestrator may decide alone ONLY when the spec/goal already answers it, or the fix stays inside in-scope paths without a contract change, citing the spec/goal line. Everything else is BLOCKED and reported at the end. Approve this rule?', 'approve', ['approve', 'stricter: block everything not in spec'])
  // H. safety
  add('H safety', 'H1', 'Environments the loop may touch: local process and docker only; no production, no shared DB, no network writes. Secrets never in prompts. Approve?', 'approve', ['approve', 'edit'])
  // I. reporting
  add('I report', 'I1', `Final report goes to: ${(t.report_to || []).join(', ') || 'not set'}. Also send interim events (BLOCKED, budget 80%)?`, 'final report only', ['final report only', 'final + events'])
  // instincts the owner should see before locking
  if (instincts) add('J learned', 'J1', `Learned instincts that will be applied:\n${instincts}\nKeep them all?`, 'keep', ['keep', 'drop some'])

  return { generated: new Date().toISOString(), questions: qs }
}

export function render(c) {
  const by = {}
  for (const q of c.questions) (by[q.group] = by[q.group] || []).push(q)
  const out = []
  for (const [g, qs] of Object.entries(by)) {
    out.push(`## ${g}`)
    for (const q of qs) out.push(`${q.id}. ${q.question}\n   recommendation: ${q.recommendation}${q.options?.length ? `\n   options: ${q.options.join(' | ')}` : ''}${q.answer ? `\n   ANSWER: ${q.answer}` : ''}`)
  }
  return out.join('\n')
}
