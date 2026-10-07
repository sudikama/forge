// Unit tests for lib/route.mjs (per-agent model/effort routing) and runner.jevDecide (hybrid
// finding decision), on the mock Jev lane so the policy is tested, not the remote model.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'forge-route-'))
process.env.FORGE_HOME = path.join(tmp, 'home')
process.env.FORGE_JEV_LANES = 'mock'
const mockFile = path.join(tmp, 'mock.mjs')
// The mock reads its script from globalThis so each case can set answers.
fs.writeFileSync(mockFile, 'export default (state, questions, purpose) => globalThis.__jev(state, questions, purpose)\n')
process.env.FORGE_JEV_MOCK = mockFile

const { route, updateLadder } = await import('../../lib/route.mjs')
const { jevDecide, exclusionLines } = await import('../../lib/runner.mjs')

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); if (!cond) failed++ }
const jev = (fn) => { globalThis.__jev = fn }
const ans = (tier, tc, effort, ec) => jev(() => ({ tier: { choice: tier, confidence: tc }, effort: { choice: effort, confidence: ec } }))
const lane = (items, extra = {}) => route({ role: 'lane', items, ...extra })
const S = [{ id: 'W1', size: 'S', title: 'rename helper', ac: ['AC-1'] }]
const L = [{ id: 'W2', size: 'L', title: 'payment flow', ac: ['AC-2', 'AC-3'] }]

// Asymmetric thresholds
ans('fast', 0.9, 'low', 0.9)
let r = await lane(S)
ok('confident fast slice goes to haiku/low', r.model === 'haiku' && r.effort === 'low', r.why)
ans('balanced', 0.9, 'medium', 0.9)
r = await lane(S)
ok('balanced tier is Sonnet 5.5 by default', r.model === 'claude-sonnet-5-5', r.model)
ans('fast', 0.6, 'low', 0.6)
r = await lane(S)
ok('unsure downgrade stays on default sonnet/medium', r.model === 'claude-sonnet-5-5' && r.effort === 'medium', r.why)
ans('deep', 0.35, 'high', 0.35)
r = await lane(S)
ok('upgrade needs only 0.3: opus/high', r.model === 'claude-opus-5-5' && r.effort === 'high', r.why)
ans('deep', 0.2, 'high', 0.2)
r = await lane(S)
ok('upgrade below 0.3 ignored', r.model === 'claude-sonnet-5-5', r.why)

// Deterministic overrides
ans('fast', 1, 'low', 1)
r = await lane(L)
ok('L-sized item never on fast tier', r.model === 'claude-sonnet-5-5', r.why)
// Model ladder: haiku 1 fail -> sonnet, sonnet 2 fails -> opus, opus 2 fails -> exhausted
{
  const lad = {}
  const fail = (tier, iter) => updateLadder(lad, { item: 'W1', tier, model: tier, iter, failed: true, why: 'case red' })
  let ev = fail('fast', 1)
  ok('haiku: first gate failure escalates straight to sonnet', ev[0]?.kind === 'escalate' && ev[0].from === 'fast' && ev[0].to === 'balanced' && lad.W1.tier === 'balanced', JSON.stringify(ev))
  ans('fast', 1, 'low', 1)
  r = await lane(S, { ladder: lad })
  ok('after escalation Jev cannot pull it back to haiku', r.model === 'claude-sonnet-5-5' && /ladder balanced/.test(r.why), r.why)
  ev = fail('balanced', 2)
  ok('sonnet: first failure is a retry on sonnet', ev[0]?.kind === 'retry' && ev[0].n === 1 && ev[0].of === 2 && lad.W1.tier === 'balanced')
  r = await lane(S, { ladder: lad })
  ok('sonnet retry runs on sonnet with effort >= medium', r.model === 'claude-sonnet-5-5' && r.effort === 'medium' && r.retry === 1, r.why)
  ev = fail('balanced', 3)
  ok('sonnet: second failure escalates to opus', ev[0]?.kind === 'escalate' && ev[0].to === 'deep' && lad.W1.tier === 'deep')
  r = await lane(S, { ladder: lad })
  ok('opus rung runs Opus 5.5 with effort high', r.model === 'claude-opus-5-5' && r.effort === 'high', r.why)
  ev = fail('deep', 4)
  ok('opus: first failure is a retry', ev[0]?.kind === 'retry' && !lad.W1.exhausted)
  ev = fail('deep', 5)
  ok('opus: second failure exhausts the ladder', ev[0]?.kind === 'exhausted' && lad.W1.exhausted === true)
  ok('attempt history kept', lad.W1.attempts.length === 5 && lad.W1.attempts.every((a) => a.failed))
}
{
  const lad = {}
  updateLadder(lad, { item: 'W2', tier: 'balanced', model: 's', iter: 1, failed: true })
  updateLadder(lad, { item: 'W2', tier: 'balanced', model: 's', iter: 2, failed: false })
  ok('a pass keeps the rung and the fail count', lad.W2.tier === 'balanced' && lad.W2.fails === 1)
  updateLadder(lad, { item: 'W3', tier: 'fast', model: 'h', iter: 1, failed: false })
  ok('a pass on haiku stays on haiku', lad.W3.tier === 'fast' && lad.W3.fails === 0)
  process.env.FORGE_LADDER_FAILS_FAST = '2'
  const l2 = {}
  const e1 = updateLadder(l2, { item: 'W4', tier: 'fast', model: 'h', iter: 1, failed: true })
  ok('fast limit is configurable', e1[0]?.kind === 'retry' && l2.W4.tier === 'fast')
  delete process.env.FORGE_LADDER_FAILS_FAST
  // Mixed lane: one item on a higher rung lifts the whole lane to that rung.
  ans('fast', 1, 'low', 1)
  r = await lane([...S, { id: 'W9', size: 'S', title: 'new', ac: [] }], { ladder: { W1: { tier: 'deep', fails: 0, attempts: [] } } })
  ok('mixed lane: ladder floor lifts the lane', r.model === 'claude-opus-5-5' && /ladder floor deep/.test(r.why), r.why)
}
ans('deep', 1, 'xhigh', 1)
r = await lane(S)
ok('effort clamped to maxEffort=high', r.effort === 'high', r.why)
ans('fast', 1, 'low', 1)
r = await route({ role: 'orchestrator', items: S })
ok('orchestrator never below sonnet/medium', r.model === 'claude-sonnet-5-5' && r.effort === 'medium', r.why)

// Jev down: defaults, no throw
jev(() => { throw new Error('lane down') })
r = await lane(S)
ok('jev down falls back to default', r.model === 'claude-sonnet-5-5' && r.effort === 'medium' && r.source === 'fallback', r.why)
process.env.FORGE_ROUTE_AGENTS = 'false'
ans('deep', 1, 'high', 1)
r = await lane(S)
ok('routing switch off keeps default', r.model === 'claude-sonnet-5-5' && r.source === 'disabled')
delete process.env.FORGE_ROUTE_AGENTS
process.env.FORGE_DEEP_MODEL = 'claude-opus-4-1'
ans('deep', 1, 'high', 1)
r = await lane(S)
ok('tier model is configurable', r.model === 'claude-opus-4-1')
delete process.env.FORGE_DEEP_MODEL

// jevDecide: hybrid finding decision
const tdir = path.join(tmp, 'task')
fs.mkdirSync(tdir, { recursive: true })
fs.writeFileSync(path.join(tdir, 'spec.md'), ['# Spec', '## Goals', '- add money()', '## Non-goals', '- currency conversion between IDR and USD', '- redesign of the CLI output', '## MUST', '- MUST NOT change the signature of plain()', ''].join('\n'))
fs.writeFileSync(path.join(tdir, 'scope.json'), JSON.stringify({ out_of_scope: [{ item: 'src/legacy/', why: 'frozen module' }] }))
const t = { dir: tdir, key: 'T-1' }
const ex = exclusionLines(t)
ok('exclusion lines: 2 non-goals + MUST NOT + scope', ex.length === 4 && ex[0].cite === 'spec.md:L5' && ex[2].cite === 'spec.md:L8', ex.map((e) => e.cite).join(','))

const f = { kind: 'scope_gap', title: 'add USD conversion to money()', evidence: 'users may want dollars' }
jev(() => ({ which: { choice: 'x0', confidence: 0.85 } }))
let d = await jevDecide(t, f)
ok('confident match rejects without LLM, cites the line', d?.decision === 'reject' && d.cite === 'spec.md:L5', d?.reason)
jev(() => ({ which: { choice: 'x0', confidence: 0.45 } }))
d = await jevDecide(t, f)
ok('weak match defers to orchestrator', d?.deferred === true && !d.decision, d?.jev)
jev(() => ({ which: { choice: 'none', confidence: 1 } }))
d = await jevDecide(t, f)
ok('"none" defers to orchestrator', d?.deferred === true)
jev(() => ({ which: { choice: 'x3', confidence: 0.9 } }))
d = await jevDecide(t, f)
ok('scope out_of_scope entry is a valid cite', d?.decision === 'reject' && d.cite === 'scope:out_of_scope:src/legacy/', d?.cite)
jev(() => { throw new Error('down') })
d = await jevDecide(t, f)
ok('jev down defers (never rejects on error)', !d?.decision)
process.env.FORGE_JEV_DECIDE = 'false'
jev(() => ({ which: { choice: 'x0', confidence: 1 } }))
ok('jevDecide switch off returns null', (await jevDecide(t, f)) === null)
delete process.env.FORGE_JEV_DECIDE

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `route: ${failed} FAILED` : 'route: ALL PASS')
process.exit(failed ? 1 : 0)
