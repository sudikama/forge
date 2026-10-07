// forge function-hook module (EARLY ACCESS API; only loaded when Claude Code runs with
// CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1). Classic hooks in hooks.json keep working without it.
//
//   session.compact : Jev-guided verbatim compaction (vendored fast-jev-compaction, MIT):
//                     Jev scores every tool call/result as still-needed or not; unneeded results
//                     are truncated, unneeded calls dropped, no summary. Falls back to the
//                     built-in summary below minReductionRatio or on any error.
//   turn.complete   : asks for a compaction at compactAtPercent of the context window.
//   agent.spawn     : routes the model of Agent-tool subagents inside an interactive session.
//
// Runs in Claude Code's hook sandbox: no Node, only `$` (http.fetch, env, settings, ui, session).
import { compact, reductionRatio, applyDecisions, messageChars } from './vendor/fast-jev/compact.js'
import { collectToolCalls } from './vendor/fast-jev/state.js'

// Reference guard (forge, deterministic): the zen lane is not calibrated and was seen scoring
// the file under edit at 0.17. A call whose input names a file/identifier that the goal or any
// LATER message text mentions is still in use, so it is kept whatever Jev says.
function refsOf(input) {
  const out = new Set()
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/[\w.\-/]*[\w-]+\.[a-z0-9]{1,6}\b|[\w-]+\/[\w.\-/]+/gi)) {
        const p = m[0]
        if (p.length < 4 || /^\d/.test(p)) continue
        out.add(p)
        const base = p.split('/').pop()
        if (base && base.length >= 4 && base.includes('.')) out.add(base)
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(input)
  return [...out]
}
export function guardDecisions(messages, decisions, goal, preserveRecent) {
  const calls = collectToolCalls(messages, preserveRecent)
  const byId = new Map(calls.map((c) => [c.id, c]))
  let rescued = 0
  const out = decisions.map((d) => {
    if (d.action === 'keep') return d
    const call = byId.get(d.id)
    if (!call) return d
    const later = goal + '\n' + messages.slice(call.resultIndex + 1).map((m) => m.text || '').join('\n')
    const hit = refsOf(call.input).find((r) => later.includes(r))
    if (!hit) return d
    rescued++
    return { ...d, action: 'keep', reason: 'kept', guard: hit }
  })
  return { decisions: out, calls, rescued }
}

const LANES = {
  zen: { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', key: null },
  commandcode: { url: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev', key: 'COMMANDCODE_API_KEY' },
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', key: 'TYPESAFE_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-latest', key: 'OPENROUTER_API_KEY' },
}
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 forge'

const num = (o, k, d) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? o[k] : d)
const str = (o, k, d) => (typeof o[k] === 'string' && o[k] ? o[k] : d)
const bool = (o, k, d) => (typeof o[k] === 'boolean' ? o[k] : d)

async function keyOf($, options, name) {
  if (!name) return ''
  if (typeof options[name] === 'string' && options[name]) return options[name]
  switch (name) {
    case 'COMMANDCODE_API_KEY': return (await $.env.get('COMMANDCODE_API_KEY')) || ''
    case 'TYPESAFE_API_KEY': return (await $.env.get('TYPESAFE_API_KEY')) || ''
    case 'OPENROUTER_API_KEY': return (await $.env.get('OPENROUTER_API_KEY')) || ''
  }
  return ''
}

// A JevAsker over $.http.fetch with forge's lane failover.
function asker($, options) {
  const order = str(options, 'jevLanes', 'zen,commandcode').split(',').map((s) => s.trim()).filter((s) => LANES[s])
  return {
    async ask(state, questions) {
      const errors = []
      for (const name of order) {
        const lane = LANES[name]
        const key = await keyOf($, options, lane.key)
        if (lane.key && !key) { errors.push(`${name}: no key`); continue }
        const headers = { 'content-type': 'application/json', 'user-agent': UA }
        if (key) headers.authorization = `Bearer ${key}`
        try {
          const res = await $.http.fetch(lane.url, { method: 'POST', headers, body: JSON.stringify({ model: lane.model, state, questions }) })
          if (!res.ok) { errors.push(`${name}: HTTP ${res.status}`); continue }
          const body = JSON.parse(res.text)
          if (!body || typeof body.answers !== 'object' || body.answers === null) { errors.push(`${name}: no answers`); continue }
          return body
        } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`) }
      }
      throw new Error(`all Jev lanes failed (${errors.join('; ')})`)
    },
  }
}

// Same message mapping as fast-jev-compaction: untouched objects keep the engine's handle.
function toSessionMessages(input, output) {
  const messages = new Map(); const uses = new Map(); const results = new Map()
  for (const m of input) {
    messages.set(m, m)
    for (const u of m.toolUses) uses.set(u, u)
    for (const r of m.toolResults ?? []) results.set(r, r)
  }
  return output.map((m) => {
    const own = messages.get(m)
    if (own) return own
    const rebuilt = { role: m.role, text: m.text, toolUses: m.toolUses.map((u) => uses.get(u) ?? { tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, ...(u.text !== undefined ? { text: u.text } : {}), ...(u.isError ? { isError: true } : {}) }) }
    if (m.toolResults?.length) rebuilt.toolResults = m.toolResults.map((r) => results.get(r) ?? { tool_use_id: r.tool_use_id, text: r.text, isError: r.isError ?? false })
    return rebuilt
  })
}

const TIER = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  const compactOn = bool(options, 'jevCompaction', true)
  const minReduction = num(options, 'minReductionRatio', 0.25)
  const compactAt = num(options, 'compactAtPercent', 60)
  let compacting = false

  if (compactOn) {
    on('session.compact', async ($, e, next) => {
      try {
        const goal = typeof e.instructions === 'string' ? e.instructions : ''
        const preserve = num(options, 'preserveRecentMessages', 6)
        const head = num(options, 'truncateHeadChars', 300)
        const raw = await compact(e.messages, asker($, options), {
          goal, keepThreshold: num(options, 'keepThreshold', 0.5), preserveRecentMessages: preserve,
          maxStateTokens: num(options, 'maxStateTokens', 25000), maxRequestTokens: num(options, 'maxRequestTokens', 30000), truncateHeadChars: head,
        })
        let result = raw
        if (bool(options, 'compactionRefGuard', true)) {
          const g = guardDecisions(e.messages, raw.decisions, goal, preserve)
          if (g.rescued) {
            const kept = applyDecisions(e.messages, g.decisions, g.calls, head)
            result = { messages: kept, decisions: g.decisions, stats: { ...raw.stats, messagesAfter: kept.length, charsAfter: kept.reduce((s, m) => s + messageChars(m), 0), rescued: g.rescued,
              resultsDropped: g.decisions.filter((d) => d.reason === 'result_dropped').length, callsDropped: g.decisions.filter((d) => d.reason === 'call_dropped').length } }
          }
        }
        const ratio = reductionRatio(result)
        if (ratio < minReduction) {
          $.ui.log(`forge compaction: ${Math.round(ratio * 100)}% < ${Math.round(minReduction * 100)}%, using built-in summary`)
          return next(e)
        }
        const messages = toSessionMessages(e.messages, result.messages)
        $.ui.log(`forge compaction: kept ${messages.length}/${e.messages.length} messages verbatim, ${Math.round(ratio * 100)}% smaller, ${result.stats.resultsDropped} results truncated, ${result.stats.callsDropped} calls dropped, ${result.stats.rescued || 0} rescued by ref guard`)
        return { messages }
      } catch (err) {
        $.ui.log(`forge compaction fallback to built-in summary (${err instanceof Error ? err.message : String(err)})`)
        return next(e)
      }
    }).catch(($, e, next) => {
      // Budget overrun or misreturn: the built-in summary, never a stuck compaction.
      $.ui.log(`forge compaction ${next.error.kind}: built-in summary`)
      return next(e)
    })

    on('turn.complete', async ($, e, next) => {
      if (compacting) return next(e)
      try {
        const { context } = await $.session.usage()
        if ((context.percent ?? 0) >= compactAt) { compacting = true; await $.session.compact() }
      } catch (err) {
        $.ui.log(`forge auto-compact skipped (${err instanceof Error ? err.message : String(err)})`)
      } finally { compacting = false }
      return next(e)
    })
  }

  if (bool(options, 'routeSessionSubagents', true)) {
    // Interactive Agent-tool subagents: pick the tier from the task text. Only when the caller
    // left the model open; forks always inherit; spending less needs high confidence.
    on('agent.spawn', async ($, e, next) => {
      if (e.fork || e.model) return next(e)
      try {
        const body = await asker($, options).ask({ subagent: e.subagentType, task: String(e.prompt).slice(0, 4000) }, {
          tier: { type: 'choice', instructions: 'Which model tier does this subagent task need?', criteria: {
            fast: 'search, read, list, summarise, or a mechanical edit',
            balanced: 'ordinary engineering: implement or fix with tests',
            deep: 'hard or risky: design, concurrency, security, data integrity, or debugging an unclear failure',
          } },
        })
        const a = body.answers?.tier
        const choice = a?.choice ?? a?.option
        const conf = Number(a?.confidence ?? a?.probabilities?.[choice] ?? 0)
        if (!TIER[choice]) return next(e)
        const down = choice === 'fast'
        if ((down && conf < num(options, 'minDowngradeConfidence', 0.7)) || (!down && conf < num(options, 'minUpgradeConfidence', 0.3))) return next(e)
        $.ui.log(`forge route: ${e.subagentType} subagent on ${TIER[choice]} (jev ${choice} ${conf.toFixed(2)})`)
        return next({ ...e, model: TIER[choice] })
      } catch {
        return next(e)
      }
    }).catch(($, e, next) => next(e))
  }
}
