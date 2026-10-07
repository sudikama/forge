// Jev (TypeSafe System One) client: four lanes, ordered failover, circuit breaker.
// Jev is a decision model, not an LLM: state + typed questions in, typed answers out.
// Every caller must treat a null result as "no decision" and fall back deterministically.
import path from 'node:path'
import { HOME_FORGE, readJson, writeJson, appendJsonl, option, secret, now } from './util.mjs'

export const LANES = {
  zen: { url: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free', key: null },
  commandcode: { url: 'https://api.commandcode.ai/provider/v1/systemone', model: 'typesafe/jev', key: 'COMMANDCODE_API_KEY' },
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', key: 'TYPESAFE_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-latest', key: 'OPENROUTER_API_KEY' },
  mock: { url: null, model: null, key: 'FORGE_JEV_MOCK' },
}

// Cloudflare in front of the lanes answers 403/1010 to a bare client; send a browser-like UA.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 forge'
const BREAKER_FILE = () => path.join(HOME_FORGE, 'state', 'jev-breaker.json')
const LOG_FILE = () => path.join(HOME_FORGE, 'logs', 'jev.jsonl')
const BREAK_AFTER = 3
const BREAK_FOR_MS = 2 * 60 * 1000

export function laneOrder() {
  const raw = option('jevLanes', 'zen,commandcode')
  return raw.split(',').map((s) => s.trim()).filter((s) => LANES[s])
}

export function laneUsable(name) {
  const lane = LANES[name]
  if (!lane) return { ok: false, why: 'unknown lane' }
  if (lane.key && !secret(lane.key)) return { ok: false, why: `${lane.key} not set` }
  const b = readJson(BREAKER_FILE(), {})[name]
  if (b && b.openUntil && Date.now() < b.openUntil) return { ok: false, why: `breaker open until ${new Date(b.openUntil).toISOString()}` }
  return { ok: true }
}

function breaker(name, ok, err) {
  const all = readJson(BREAKER_FILE(), {})
  const b = all[name] || { fails: 0 }
  if (ok) { b.fails = 0; b.openUntil = 0 } else {
    b.fails += 1
    b.lastError = err
    // A daily quota (429 "quota resets") keeps the lane closed much longer than a blip.
    const quota = /quota|resets/i.test(err || '')
    if (b.fails >= BREAK_AFTER || quota) b.openUntil = Date.now() + (quota ? 60 * 60 * 1000 : BREAK_FOR_MS)
  }
  all[name] = b
  writeJson(BREAKER_FILE(), all)
}

// Test lane: FORGE_JEV_MOCK=/path/answers.mjs exporting default (state, questions, purpose) => answers.
// Returning null/undefined passes to the next lane, so a test can script one purpose only.
async function callMock(state, questions, purpose) {
  const mod = await import(process.env.FORGE_JEV_MOCK || secret('FORGE_JEV_MOCK'))
  const answers = await mod.default(state, questions, purpose)
  if (answers == null) throw Object.assign(new Error(`mock passes on ${purpose}`), { pass: true })
  return { answers: normalize(answers, questions), usage: {}, ms: 0 }
}

async function callLane(name, state, questions, timeoutMs, purpose) {
  if (name === 'mock') return callMock(state, questions, purpose)
  const lane = LANES[name]
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA }
  if (lane.key) headers.Authorization = `Bearer ${secret(lane.key)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(lane.url, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({ model: option(`${name}Model`, lane.model), state, questions }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
    const body = JSON.parse(text)
    if (!body.answers || typeof body.answers !== 'object') throw new Error('malformed body: no answers')
    return { answers: normalize(body.answers, questions), usage: body.usage || {}, ms: Date.now() - t0 }
  } finally { clearTimeout(timer) }
}

// Reduce each provider answer to { choice, confidence, probabilities } | { noul } | { score }.
export function normalize(answers, questions) {
  const out = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id]
    if (!a) continue
    if (q.type === 'choice') {
      const choice = a.choice ?? a.option ?? a.answer
      if (typeof choice !== 'string' || !(choice in q.criteria)) continue
      out[id] = { choice, confidence: Number(a.confidence ?? a.probabilities?.[choice] ?? 0), probabilities: a.probabilities || {} }
    } else if (q.type === 'noul') {
      const p = Number(a.noul ?? a.probability ?? a.answer)
      if (Number.isFinite(p)) out[id] = { noul: p }
    } else if (q.type === 'score') {
      const s = Number(a.score ?? a.answer)
      if (Number.isFinite(s)) out[id] = { score: s }
    }
  }
  return out
}

// Ask Jev. Returns { answers, lane, ms } or null when every lane failed (callers fall back).
export async function ask(state, questions, { purpose = 'unspecified', timeoutMs } = {}) {
  const budget = Number(timeoutMs ?? option('jevTimeoutMs', 8000))
  const tried = []
  for (const name of laneOrder()) {
    const u = laneUsable(name)
    if (!u.ok) { tried.push(`${name}: skipped (${u.why})`); continue }
    try {
      const r = await callLane(name, state, questions, budget, purpose)
      breaker(name, true)
      appendJsonl(LOG_FILE(), { at: now(), purpose, lane: name, ms: r.ms, ok: true, answered: Object.keys(r.answers).length })
      return { ...r, lane: name, tried }
    } catch (e) {
      const msg = e.name === 'AbortError' ? `timeout ${budget}ms` : e.message
      if (e.pass) { tried.push(`${name}: pass`); continue }
      breaker(name, false, msg)
      tried.push(`${name}: ${msg}`)
      appendJsonl(LOG_FILE(), { at: now(), purpose, lane: name, ok: false, error: msg })
    }
  }
  return { answers: null, lane: null, tried }
}

// Question builders, so call sites stay readable.
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria })
export const noul = (instructions) => ({ type: 'noul', instructions })
