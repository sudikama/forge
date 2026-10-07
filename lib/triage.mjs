// Size triage: is this prompt a small task (plan-build-test harness in one session)
// or a large one (goal + spec + orchestrated loop)? Two passes:
//   pass 1 (prompt.submit): Jev prior + deterministic cues, cheap, may be wrong;
//   pass 2 (after the worklist exists): deterministic, may only escalate small -> large.
import { ask, choice, noul } from './jev.mjs'
import { option } from './util.mjs'

const QUESTIONS = {
  is_engineering: noul('Is this message a request to change, build, fix, migrate or optimize software in a code repository (not a question, chat, or explanation request)?'),
  scale: choice('How large is the engineering work this request asks for?', {
    small: 'a bug fix, one function, one file or a few closely related lines; a single coherent change',
    medium: 'one feature touching a handful of files in one module, with tests',
    large: 'many modules or services, a new subsystem, a migration, or a multi-step project needing a plan and several independent workstreams',
  }),
  parallelizable: noul('Can this work be split into several independent sub-tasks that separate workers could do in parallel?'),
  has_verifier: noul('Does the request name or imply an objective, machine-checkable success criterion (tests, a metric, a build, a benchmark)?'),
}

const LARGE_CUES = /\b(migra(te|si|tion)|rewrite|refactor (the )?(whole|entire|all)|seluruh|semua modul|end[- ]to[- ]end|epic|subsystem|arsitektur|architecture|multi[- ]?(service|module)|from scratch|dari nol|platform)\b/i
const SOURCE_CUES = /\b([A-Z][A-Z0-9]+-\d+)\b|docs\.google\.com|figma\.com|\.pdf\b|\bPRD\b/

export function cues(text) {
  return {
    ticket: (text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null,
    has_source: SOURCE_CUES.test(text),
    large_words: LARGE_CUES.test(text),
    length: text.length,
  }
}

export async function triagePrompt(text) {
  const c = cues(text)
  const r = await ask({ request: text.slice(0, 6000) }, QUESTIONS, { purpose: 'triage' })
  const a = r.answers || {}
  const isEng = a.is_engineering ? a.is_engineering.noul >= Number(option('engThreshold', 0.6)) : (c.large_words || c.ticket ? true : null)
  let size = a.scale?.choice || null
  const conf = a.scale?.confidence ?? null
  // Escalate on deterministic cues even when Jev says small or did not answer.
  if (c.large_words || (c.has_source && c.length > 400)) size = size === 'small' || !size ? 'medium' : size
  if (c.large_words && (a.parallelizable?.noul ?? 0) >= 0.6) size = 'large'
  // A vague request is NOT a large request: low confidence + no verifier means clarify, not loop.
  // Measured: Jev's scale confidence does not separate vague from clear (0.52 on "make the app
  // better"); has_verifier does (0.06 vs 0.95+). A small fix without a verifier is fine (the small
  // harness demands test cases anyway); anything bigger without one is clarified first.
  const vague = (a.has_verifier?.noul ?? 1) < Number(option('verifierThreshold', 0.3)) && size !== 'small' && !c.ticket && !c.has_source
  const lane = !isEng ? 'none' : vague ? 'clarify' : size === 'large' ? 'large' : size ? 'small' : 'unknown'
  return {
    lane, size, confidence: conf, vague,
    signals: {
      is_engineering: a.is_engineering?.noul ?? null, parallelizable: a.parallelizable?.noul ?? null,
      has_verifier: a.has_verifier?.noul ?? null,
    },
    cues: c, jev_lane: r.lane, jev_tried: r.tried,
  }
}

// Pass 2: from a planned worklist (small tasks also produce one, a single item is fine).
export function triageWorklist(worklist, lanePlan) {
  const items = worklist.items || []
  const files = new Set(items.flatMap((i) => i.writes || []))
  const dirs = new Set([...files].map((f) => f.split('/').slice(0, 2).join('/')))
  const reasons = []
  if (items.length >= 4) reasons.push(`${items.length} work items`)
  if (files.size >= 8) reasons.push(`${files.size} write targets`)
  if (dirs.size >= 3) reasons.push(`${dirs.size} top-level areas`)
  if (lanePlan && lanePlan.clusters.length >= 2 && lanePlan.recommended_workers >= 2) reasons.push(`${lanePlan.clusters.length} independent clusters`)
  if (items.some((i) => i.size === 'L')) reasons.push('an L-sized item')
  return { large: reasons.length >= 2, reasons }
}
