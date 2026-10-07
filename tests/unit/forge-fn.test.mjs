// Unit harness for hooks/forge-fn.js outside Claude Code: a fake `on` + `$` that mirror the
// function-hook contract (session.compact / turn.complete / agent.spawn, $.http.fetch -> {status, ok, text}).
// Jev answers come from a scripted fetch (deterministic) or the live zen lane with LIVE=1.
import { register } from '../../hooks/forge-fn.js'

let failed = 0
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); if (!cond) failed++ }

function engine({ options = {}, answer, usagePercent = 70, live = false }) {
  const hooks = {}
  const logs = []
  const calls = { fetch: 0, compact: 0 }
  const on = (ev, fn) => { hooks[ev] = { fn }; return { catch: (h) => { hooks[ev].catch = h } } }
  register(on, options)
  const $ = {
    ui: { log: (m) => logs.push(m), toast: () => {} },
    env: { get: async () => undefined },
    session: { usage: async () => ({ context: { percent: usagePercent } }), compact: async () => { calls.compact++ } },
    http: {
      fetch: async (url, init) => {
        calls.fetch++
        if (live) {
          const r = await fetch(url, init)
          return { status: r.status, ok: r.ok, text: await r.text() }
        }
        const { questions } = JSON.parse(init.body)
        const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answer(k, q)]))
        return { status: 200, ok: true, text: JSON.stringify({ answers }) }
      },
    },
  }
  return { hooks, $, logs, calls }
}

const big = 'x'.repeat(6000)
const msg = (role, text, extra = {}) => ({ role, text, toolUses: [], ...extra })
const transcript = () => [
  msg('user', 'Add money() to src/fmt.mjs with tests', { handle: 'h0' }),
  msg('assistant', '', { toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'node_modules/huge/README.md' }, text: big }], handle: 'h1' }),
  msg('user', '', { toolResults: [{ tool_use_id: 't1', text: big, isError: false }], handle: 'h2' }),
  msg('assistant', '', { toolUses: [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'ls -R node_modules' }, text: big }], handle: 'h3' }),
  msg('user', '', { toolResults: [{ tool_use_id: 't2', text: big, isError: false }], handle: 'h4' }),
  msg('assistant', '', { toolUses: [{ tool_use_id: 't3', tool: 'Read', input: { file_path: 'src/fmt.mjs' }, text: 'export function plain(n) { return String(n) }' }], handle: 'h5' }),
  msg('user', '', { toolResults: [{ tool_use_id: 't3', text: 'export function plain(n) { return String(n) }', isError: false }], handle: 'h6' }),
  msg('assistant', 'Writing money() now.', { handle: 'h7' }),
  msg('user', 'ok', { handle: 'h8' }),
  msg('assistant', 'done', { handle: 'h9' }),
  msg('user', 'run tests', { handle: 'h10' }),
  msg('assistant', 'running', { handle: 'h11' }),
]
const nextBuiltin = async () => ({ builtin: true })
const size = (ms) => JSON.stringify(ms).length

// 1) compaction keeps what Jev says is needed (src/fmt.mjs) and truncates the noise, verbatim, no summary
{
  const E = engine({ options: { preserveRecentMessages: 4 }, answer: (k) => ({ type: 'noul', noul: /t3/.test(k) ? 0.95 : 0.05 }) })
  const tr = transcript()
  const out = await E.hooks['session.compact'].fn(E.$, { trigger: 'auto', messages: tr }, nextBuiltin)
  ok('compaction returns messages, not the built-in summary', Array.isArray(out?.messages), E.logs.at(-1))
  ok('compaction shrinks the transcript', out?.messages && size(out.messages) < size(tr) * 0.5, out?.messages && `${size(tr)} -> ${size(out.messages)} chars`)
  const keptT3 = out?.messages?.some((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't3' && r.text.includes('plain')))
  ok('needed tool result kept verbatim', keptT3)
  ok('untouched messages keep the engine handle', out?.messages?.[0]?.handle === 'h0' && out.messages.at(-1).handle === 'h11')
}
// 1b) ref guard: Jev (uncalibrated) drops everything, but the file named in the goal survives
{
  const E = engine({ options: { preserveRecentMessages: 4 }, answer: () => ({ type: 'noul', noul: 0.1 }) })
  const tr = transcript()
  const out = await E.hooks['session.compact'].fn(E.$, { trigger: 'auto', messages: tr, instructions: 'implement money() in src/fmt.mjs' }, nextBuiltin)
  const keptT3 = out?.messages?.some((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't3'))
  const keptT1 = out?.messages?.some((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't1'))
  ok('ref guard rescues the file named in the goal', keptT3, E.logs.at(-1))
  ok('ref guard does not rescue unrelated noise', !keptT1)
  const F = engine({ options: { preserveRecentMessages: 4, compactionRefGuard: false }, answer: () => ({ type: 'noul', noul: 0.1 }) })
  const off = await F.hooks['session.compact'].fn(F.$, { trigger: 'auto', messages: transcript(), instructions: 'implement money() in src/fmt.mjs' }, nextBuiltin)
  ok('ref guard can be switched off', !off?.messages?.some((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't3')))
}
// 2) Jev says everything is needed: reduction too small, fall back to the built-in summary
{
  const E = engine({ answer: () => ({ type: 'noul', noul: 0.99 }) })
  const out = await E.hooks['session.compact'].fn(E.$, { trigger: 'auto', messages: transcript() }, nextBuiltin)
  ok('below minReductionRatio falls back to built-in', out?.builtin === true, E.logs.at(-1))
}
// 3) Jev down: fall back, never throw
{
  const E = engine({ answer: () => { throw new Error('boom') } })
  E.$.http.fetch = async () => ({ status: 503, ok: false, text: 'down' })
  const out = await E.hooks['session.compact'].fn(E.$, { trigger: 'auto', messages: transcript() }, nextBuiltin)
  ok('all lanes down falls back to built-in', out?.builtin === true, E.logs.at(-1))
  ok('catch handler registered for compaction', typeof E.hooks['session.compact'].catch === 'function')
}
// 4) turn.complete triggers a compaction above the threshold only
{
  const E = engine({ answer: () => ({}), usagePercent: 72 })
  await E.hooks['turn.complete'].fn(E.$, {}, async () => ({}))
  const F = engine({ answer: () => ({}), usagePercent: 40 })
  await F.hooks['turn.complete'].fn(F.$, {}, async () => ({}))
  ok('auto-compact at 72% >= 60%, not at 40%', E.calls.compact === 1 && F.calls.compact === 0)
}
// 5) agent.spawn routing: up easily, down only with high confidence, never on fork or explicit model
{
  const mk = (choice, confidence) => engine({ answer: () => ({ choice, confidence }) })
  const spawn = async (E, e) => { let seen; await E.hooks['agent.spawn'].fn(E.$, e, async (x) => { seen = x; return { model: x.model || 'inherit' } }); return seen }
  const base = { prompt: 'p', subagentType: 'general-purpose', fork: false }
  ok('deep at 0.4 upgrades to Opus 5.5', (await spawn(mk('deep', 0.4), base)).model === 'claude-opus-5-5')
  ok('fast at 0.5 does not downgrade', (await spawn(mk('fast', 0.5), base)).model === undefined)
  ok('fast at 0.9 downgrades to haiku', (await spawn(mk('fast', 0.9), base)).model === 'haiku')
  ok('explicit model is respected', (await spawn(mk('deep', 1), { ...base, model: 'sonnet' })).model === 'sonnet')
  ok('fork always inherits', (await spawn(mk('deep', 1), { ...base, fork: true })).model === undefined)
}
// 6) live zen: the real lane answers and the compaction is accepted or falls back cleanly
if (process.env.LIVE) {
  const E = engine({ options: { preserveRecentMessages: 4 }, live: true })
  const out = await E.hooks['session.compact'].fn(E.$, { trigger: 'auto', messages: transcript(), instructions: 'implement money() in src/fmt.mjs' }, nextBuiltin)
  ok('live zen compaction ran', E.calls.fetch > 0, E.logs.join(' | '))
  if (out?.messages) ok('live: src/fmt.mjs result kept', out.messages.some((m) => (m.toolResults || []).some((r) => r.tool_use_id === 't3' && r.text.includes('plain'))), `${size(transcript())} -> ${size(out.messages)}`)
  let seen
  await E.hooks['agent.spawn'].fn(E.$, { prompt: 'List every file under src/ and summarise what each exports', subagentType: 'Explore', fork: false }, async (x) => { seen = x; return {} })
  console.log(`  live agent.spawn Explore listing task -> ${seen?.model || 'inherit'} | ${E.logs.at(-1)}`)
}
console.log(failed ? `forge-fn: ${failed} FAILED` : 'forge-fn: ALL PASS')
process.exit(failed ? 1 : 0)
