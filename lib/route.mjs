// Per-agent model + effort routing for loop agents (each one is a fresh `claude -p`, so a
// model switch costs no prompt cache). Jev reads the slice; policy decides, asymmetrically:
// spending more needs little confidence, spending less needs a lot. Deterministic rules
// override Jev both ways: repeated failure escalates, the orchestrator is never downgraded.
import { ask, choice } from './jev.mjs'
import { option } from './util.mjs'

export const TIERS = ['fast', 'balanced', 'deep']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh']

export function tierModel(tier) {
  return {
    fast: option('fastModel', 'haiku'),
    balanced: option('balancedModel', 'sonnet'),
    deep: option('deepModel', 'opus'),
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

// ctx: { role, items: [{id,size,title,ac}], fails: {itemId: consecutiveFailures}, failureClass, firstError }
export async function route(ctx) {
  const def = { tier: option('defaultTier', 'balanced'), effort: option('defaultEffort', 'medium') }
  if (option('routeAgents', 'true') === 'false') return { ...def, model: tierModel(def.tier), source: 'disabled', why: 'routing off' }
  const maxFails = Math.max(0, ...(ctx.items || []).map((i) => ctx.fails?.[i.id] || 0))
  const sizes = (ctx.items || []).map((i) => i.size)
  const state = {
    role: ctx.role,
    items: (ctx.items || []).map((i) => ({ id: i.id, size: i.size, title: i.title, acceptance_criteria: (i.ac || []).length })),
    consecutive_failures: maxFails,
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
  if (a.tier) {
    const d = rank(TIERS, a.tier.choice) - rank(TIERS, def.tier)
    if ((d > 0 && a.tier.confidence >= up) || (d < 0 && a.tier.confidence >= down)) { tier = a.tier.choice; why.push(`jev tier ${a.tier.choice} ${a.tier.confidence.toFixed(2)}`) }
    else if (d !== 0) why.push(`jev tier ${a.tier.choice} ${a.tier.confidence.toFixed(2)} below bar`)
  }
  if (a.effort) {
    const d = rank(EFFORTS, a.effort.choice) - rank(EFFORTS, def.effort)
    if ((d > 0 && a.effort.confidence >= up) || (d < 0 && a.effort.confidence >= down)) { effort = a.effort.choice; why.push(`jev effort ${a.effort.choice} ${a.effort.confidence.toFixed(2)}`) }
  }
  // Deterministic overrides.
  if (sizes.includes('L') && rank(TIERS, tier) < rank(TIERS, 'balanced')) { tier = 'balanced'; why.push('L-sized item: never fast') }
  if (maxFails >= Number(option('escalateAfterFails', 2))) { tier = 'deep'; effort = EFFORTS[Math.max(rank(EFFORTS, effort), rank(EFFORTS, 'high'))]; why.push(`${maxFails} consecutive failures: escalate`) }
  else if (maxFails === 1 && rank(TIERS, tier) < rank(TIERS, 'balanced')) { tier = 'balanced'; why.push('failed once: not fast') }
  if (ctx.role === 'orchestrator') {
    if (rank(TIERS, tier) < rank(TIERS, 'balanced')) { tier = 'balanced'; why.push('orchestrator never below balanced') }
    if (rank(EFFORTS, effort) < rank(EFFORTS, 'medium')) effort = 'medium'
  }
  effort = clampEffort(effort)
  return { tier, effort, model: tierModel(tier), source: r.lane ? `jev:${r.lane}` : 'fallback', why: why.join('; ') || 'default' }
}
