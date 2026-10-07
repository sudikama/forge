// Per-agent model + effort routing for loop agents (each one is a fresh `claude -p`, so a
// model switch costs no prompt cache). Jev picks the STARTING tier of a slice, asymmetrically:
// spending more needs little confidence, spending less needs a lot. After that the gate drives
// a per-item ladder (haiku 1 fail, sonnet 2 fails, opus 2 fails then BLOCKED); Jev no longer moves it.
import { ask, choice } from './jev.mjs'
import { option } from './util.mjs'

export const TIERS = ['fast', 'balanced', 'deep']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh']

export function tierModel(tier) {
  return {
    fast: option('fastModel', 'haiku'),
    balanced: option('balancedModel', 'claude-sonnet-5-5'),
    deep: option('deepModel', 'claude-opus-5-5'),
  }[tier]
}

const QUESTIONS = {
  tier: choice('Which model tier does this coding work need to be done right on the first attempt?', {
    fast: 'mechanical and local: rename, small formatter, config, a single obvious function, copying an existing pattern',
    balanced: 'ordinary engineering: a feature slice across a few files with tests, a clear bug fix',
    deep: 'hard or risky: concurrency, data integrity, security, tricky algorithms, cross-module design, or a fix that already failed',
  }),
  effort: choice('How much reasoning effort should the agent spend before acting?', {
    low: 'the change is spelled out; just do it',
    medium: 'needs some reading and a plan',
    high: 'needs careful analysis of code and failure output',
    xhigh: 'previous attempts failed for unclear reasons; deep investigation needed',
  }),
}

const rank = (list, v) => list.indexOf(v)
const clampEffort = (e) => EFFORTS[Math.min(rank(EFFORTS, e), rank(EFFORTS, option('maxEffort', 'high')))]

// ---------- model ladder (per item, driven by the gate) ----------
// An item starts on the tier routing picked. Every gate failure (red case, regression, rejected
// or unmergeable lane) counts against the tier it ran on. When the count reaches that tier's
// limit the item climbs one tier: fast (haiku) fails once -> balanced (sonnet); balanced fails
// twice -> deep (opus); deep fails twice -> BLOCKED for the owner. A pass keeps the rung.
const LIMIT_KEY = { fast: 'ladderFailsFast', balanced: 'ladderFailsBalanced', deep: 'ladderFailsDeep' }
const LIMIT_DEF = { fast: 1, balanced: 2, deep: 2 }
export const failLimit = (tier) => Math.max(1, Number(option(LIMIT_KEY[tier], LIMIT_DEF[tier])))
export const ladderSummary = () => TIERS.map((x) => `${x} ${failLimit(x)}`).join(', ')

// ladder: { [itemId]: { tier, fails, attempts: [{iter, tier, model, failed, why}] } }
// outcome: { item, tier, model, failed, why, iter }. Returns events for the log/report.
export function updateLadder(ladder, outcome) {
  const st = ladder[outcome.item] || (ladder[outcome.item] = { tier: outcome.tier, fails: 0, attempts: [] })
  // A lane can run an item above its own rung (mixed lane, L item): that tier becomes its rung.
  if (rank(TIERS, outcome.tier) > rank(TIERS, st.tier)) { st.tier = outcome.tier; st.fails = 0 }
  st.attempts.push({ iter: outcome.iter, tier: outcome.tier, model: outcome.model, failed: !!outcome.failed, why: outcome.why || '' })
  if (!outcome.failed) return []
  st.fails += 1
  const limit = failLimit(st.tier)
  if (st.fails < limit) return [{ item: outcome.item, kind: 'retry', tier: st.tier, n: st.fails, of: limit, why: outcome.why }]
  const next = TIERS[rank(TIERS, st.tier) + 1]
  if (!next) { st.exhausted = true; return [{ item: outcome.item, kind: 'exhausted', tier: st.tier, n: st.fails, why: outcome.why }] }
  const from = st.tier
  st.tier = next
  st.fails = 0
  return [{ item: outcome.item, kind: 'escalate', from, to: next, n: limit, why: outcome.why }]
}

// ctx: { role, items: [{id,size,title,ac}], ladder, failureClass, firstError }
export async function route(ctx) {
  const def = { tier: option('defaultTier', 'balanced'), effort: option('defaultEffort', 'medium') }
  const items = ctx.items || []
  const rungs = items.map((i) => ctx.ladder?.[i.id]).filter(Boolean)
  const floor = rungs.reduce((m, st) => (rank(TIERS, st.tier) > rank(TIERS, m) ? st.tier : m), null)
  const retry = Math.max(0, ...rungs.map((st) => st.fails))
  const allOnLadder = items.length > 0 && rungs.length === items.length
  if (option('routeAgents', 'true') === 'false') {
    const tier = floor && rank(TIERS, floor) > rank(TIERS, def.tier) ? floor : def.tier
    return { ...def, tier, model: tierModel(tier), source: 'disabled', why: floor ? `routing off; ladder ${floor}` : 'routing off', retry }
  }
  const sizes = items.map((i) => i.size)
  const state = {
    role: ctx.role,
    items: items.map((i) => ({ id: i.id, size: i.size, title: i.title, acceptance_criteria: (i.ac || []).length })),
    failed_attempts_on_current_model: retry,
    last_failure_class: ctx.failureClass || 'none',
    last_error: (ctx.firstError || '').slice(0, 300),
  }
  const r = await ask(state, QUESTIONS, { purpose: `route-${ctx.role}`, timeoutMs: Number(option('routeTimeoutMs', 6000)) })
  const a = r.answers || {}
  const up = Number(option('minUpgradeConfidence', 0.3))
  const down = Number(option('minDowngradeConfidence', 0.7))
  let tier = def.tier
  let effort = def.effort
  const why = []
  if (a.tier && !allOnLadder) {
    const d = rank(TIERS, a.tier.choice) - rank(TIERS, def.tier)
    if ((d > 0 && a.tier.confidence >= up) || (d < 0 && a.tier.confidence >= down)) { tier = a.tier.choice; why.push(`jev tier ${a.tier.choice} ${a.tier.confidence.toFixed(2)}`) }
    else if (d !== 0) why.push(`jev tier ${a.tier.choice} ${a.tier.confidence.toFixed(2)} below bar`)
  }
  if (a.effort) {
    const d = rank(EFFORTS, a.effort.choice) - rank(EFFORTS, def.effort)
    if ((d > 0 && a.effort.confidence >= up) || (d < 0 && a.effort.confidence >= down)) { effort = a.effort.choice; why.push(`jev effort ${a.effort.choice} ${a.effort.confidence.toFixed(2)}`) }
  }
  // Deterministic overrides. The ladder is authoritative once an item has been through a gate:
  // its rung is the tier (Jev no longer picks the tier for it, so it cannot skip or undo a rung).
  if (floor) {
    if (allOnLadder) { tier = floor; why.push(`ladder ${floor}${retry ? `, ${retry}/${failLimit(floor)} fails` : ''}`) }
    else if (rank(TIERS, floor) > rank(TIERS, tier)) { tier = floor; why.push(`ladder floor ${floor}`) }
  }
  if (sizes.includes('L') && rank(TIERS, tier) < rank(TIERS, 'balanced')) { tier = 'balanced'; why.push('L-sized item: never fast') }
  // A retry thinks harder; the top rung always thinks hard.
  if (retry > 0 && rank(EFFORTS, effort) < rank(EFFORTS, 'medium')) { effort = 'medium'; why.push('retry: effort >= medium') }
  if (tier === 'deep' && rank(EFFORTS, effort) < rank(EFFORTS, 'high')) effort = 'high'
  if (ctx.role === 'orchestrator') {
    if (rank(TIERS, tier) < rank(TIERS, 'balanced')) { tier = 'balanced'; why.push('orchestrator never below balanced') }
    if (rank(EFFORTS, effort) < rank(EFFORTS, 'medium')) effort = 'medium'
  }
  effort = clampEffort(effort)
  return { tier, effort, model: tierModel(tier), source: r.lane ? `jev:${r.lane}` : 'fallback', why: why.join('; ') || 'default', retry }
}
