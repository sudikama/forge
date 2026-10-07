// Final report: what got done, what is BLOCKED (with question, options, evidence),
// new-ticket proposals for out-of-scope findings, the metric curve, and what was learned.
import fs from 'node:fs'
import path from 'node:path'
import { readArt, art } from './task.mjs'

function curveOf(vals) {
  const v = vals.filter((x) => typeof x === 'number')
  return v.length >= 2 ? v.join(', ') : ''
}

export function writeReport(t, { iterations, items, blocked, findings, harvested }) {
  const goal = readArt(t, 'goal.json', {})
  const base = readArt(t, 'baseline.json', {})
  const ev = t.best?.eval
  const kept = iterations.filter((i) => i.verdict === 'keep')
  const L = []
  L.push(`# forge report ${t.key}: ${t.state}`, '')
  L.push(`Stop reason: ${t.stop_reason}`)
  L.push(`Branch: ${t.loop_branch} (base ${String(t.base_commit).slice(0, 8)} on ${t.base_branch}); best commit ${t.best?.commit?.slice(0, 8) || 'none'}`)
  L.push(`Iterations: ${iterations.length} (${kept.length} kept, ${iterations.length - kept.length} discarded)`, '')
  L.push('## Goal')
  L.push(`- Objective: ${goal.objective}`)
  L.push(`- Metric ${goal.metric?.name || goal.metric?.cmd}: baseline ${base.metric ?? 'n/a'}, best ${t.best?.metric ?? 'n/a'} (target ${goal.metric?.direction} ${goal.metric?.target})`)
  const curve = curveOf(kept.map((i) => i.metric))
  if (curve) L.push(`- Metric per kept iteration: ${curve}`)
  L.push(`- Acceptance: ${ev ? `${ev.ac_pass}/${ev.ac_total}` : 'n/a'}; suite green: ${ev?.suite_green ?? 'n/a'}; regressions vs baseline: ${ev?.regressions?.length ? ev.regressions.join(', ') : 'none'}`, '')
  L.push('## Work items')
  for (const i of items) L.push(`- ${i.id} [${i.status}] ${i.title}${i.blocked_by ? ` (blocked by ${i.blocked_by})` : ''}`)
  L.push('')
  L.push(`## BLOCKED: needs your decision (${blocked.length})`)
  if (!blocked.length) L.push('- none')
  for (const f of blocked) {
    L.push(`- ${f.id} (${f.kind}) ${f.title}`)
    L.push(`  - evidence: ${String(f.evidence).slice(0, 400)}`)
    if (f.options?.length) L.push(`  - options: ${f.options.join(' | ')}`)
    L.push(`  - why blocked: ${f.decision?.rule || f.decision?.reason || 'outside goal/spec'}`)
    if (f.decision?.question) L.push(`  - question: ${f.decision.question}`)
  }
  L.push('')
  const proposals = findings.filter((f) => f.status === 'noted')
  L.push(`## Proposed new tickets (out of scope, not worked on) (${proposals.length})`)
  if (!proposals.length) L.push('- none')
  for (const f of proposals) L.push(`- ${f.id} (${f.kind}) ${f.title}: ${String(f.evidence).slice(0, 300)}`)
  L.push('')
  const decided = findings.filter((f) => ['decided', 'rejected'].includes(f.status))
  L.push(`## Decisions taken by the orchestrator (${decided.length})`)
  if (!decided.length) L.push('- none')
  for (const f of decided) L.push(`- ${f.id} ${f.status}: ${f.decision?.instruction || f.decision?.reason || ''} (cite ${f.decision?.cite})`)
  L.push('')
  L.push('## Learned (instincts, repo-scoped)')
  const lr = [...(harvested?.captured || []), ...(harvested?.mutated || [])]
  if (!lr.length) L.push('- nothing new with enough evidence')
  for (const x of lr) L.push(`- ${x.kind || 'mutate'} ${x.id}: ${x.from !== undefined ? `${x.from} to ` : ''}${x.to}${x.deleted ? ' (deleted)' : ''}`)
  L.push('')
  L.push('## Proposals for forge itself (need your approval, never applied automatically)')
  const fc = {}
  for (const i of iterations) if (i.failure_class) fc[i.failure_class] = (fc[i.failure_class] || 0) + 1
  const props = []
  if ((fc.environment || 0) >= 2) props.push(`${fc.environment} iterations failed on environment: add an environment check to the baseline step for this repo`)
  if ((fc.spec_gap || 0) >= 2) props.push(`${fc.spec_gap} iterations failed on spec gaps: the clarify checklist missed something; review the spec template`)
  if (iterations.length && kept.length / iterations.length < 0.2) props.push(`keep rate ${Math.round((kept.length / iterations.length) * 100)}%: worklist slices may be too large`)
  if (!props.length) L.push('- none')
  for (const p of props) L.push(`- ${p}`)
  L.push('', 'Merging or pushing is yours: forge never merges.')
  const p = art(t, 'report.md')
  fs.writeFileSync(p, L.join('\n') + '\n')
  return p
}
