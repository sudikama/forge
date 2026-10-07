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

const { route } = await import('../../lib/route.mjs')
const { jevDecide, exclusionLines } = await import('../../lib/runner.mjs')

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); if (!cond) failed++ }
const jev = (fn) => { globalThis.__jev = fn }
const ans = (tier, tc, effort, ec) => jev(() => ({ tier: { choice: tier, confidence: tc }, effort: { choice: effort, confidence: ec } }))
const lane = (items, extra = {}) => route({ role: 'lane', items, fails: {}, ...extra })
const S = [{ id: 'W1', size: 'S', title: 'rename helper', ac: ['AC-1'] }]
const L = [{ id: 'W2', size: 'L', title: 'payment flow', ac: ['AC-2', 'AC-3'] }]

// Asymmetric thresholds
ans('fast', 0.9, 'low', 0.9)
let r = await lane(S)
ok('confident fast slice goes to haiku/low', r.model === 'haiku' && r.effort === 'low', r.why)
ans('fast', 0.6, 'low', 0.6)
r = await lane(S)
ok('unsure downgrade stays on default sonnet/medium', r.model === 'sonnet' && r.effort === 'medium', r.why)
ans('deep', 0.35, 'high', 0.35)
r = await lane(S)
ok('upgrade needs only 0.3: opus/high', r.model === 'opus' && r.effort === 'high', r.why)
ans('deep', 0.2, 'high', 0.2)
r = await lane(S)
ok('upgrade below 0.3 ignored', r.model === 'sonnet', r.why)

// Deterministic overrides
ans('fast', 1, 'low', 1)
r = await lane(L)
ok('L-sized item never on fast tier', r.model === 'sonnet', r.why)
r = await lane(S, { fails: { W1: 1 } })
ok('one failure lifts fast to balanced', r.model === 'sonnet', r.why)
r = await lane(S, { fails: { W1: 2 } })
ok('two consecutive failures escalate to opus/high', r.model === 'opus' && r.effort === 'high', r.why)
ans('deep', 1, 'xhigh', 1)
r = await lane(S)
ok('effort clamped to maxEffort=high', r.effort === 'high', r.why)
ans('fast', 1, 'low', 1)
r = await route({ role: 'orchestrator', items: S, fails: {} })
ok('orchestrator never below sonnet/medium', r.model === 'sonnet' && r.effort === 'medium', r.why)

// Jev down: defaults, no throw
jev(() => { throw new Error('lane down') })
r = await lane(S)
ok('jev down falls back to default', r.model === 'sonnet' && r.effort === 'medium' && r.source === 'fallback', r.why)
process.env.FORGE_ROUTE_AGENTS = 'false'
ans('deep', 1, 'high', 1)
r = await lane(S)
ok('routing switch off keeps default', r.model === 'sonnet' && r.source === 'disabled')
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
