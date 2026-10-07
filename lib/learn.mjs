// Self-improvement, scoped to what the owner allowed: per-repo instincts only
// (failure patterns, the test command that works, edge cases that keep catching bugs).
// Format follows hermes-squad instincts; store is ~/.forge/learn; squad instincts are read-only.
// Confidence moves are automatic (low risk). Template/prompt/code changes are only ever
// written as proposals into the final report for the owner to approve.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HOME_FORGE, sha256 } from './util.mjs'

const LEARN = () => path.join(HOME_FORGE, 'learn', 'repos')
const SQUAD = () => path.join(os.homedir(), '.hermes', 'squad-instincts', 'repos')
export const MAX_CAPTURE = 2
export const DELETE_BELOW = 0.4

export function parseYaml(text) {
  const o = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/)
    if (!m) continue
    let [, k, v] = m
    v = v.replace(/\s+#.*$/, '').trim()
    if (v === '>' || v === '|') {
      const buf = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) buf.push(lines[++i].trim())
      v = buf.join(v === '>' ? ' ' : '\n').trim()
    } else v = v.replace(/^['"]|['"]$/g, '')
    o[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  return o
}

function toYaml(o) {
  const q = (s) => JSON.stringify(String(s))
  const order = ['id', 'trigger', 'confidence', 'domain', 'source', 'scope', 'repo', 'created', 'updated', 'action', 'evidence', 'history']
  return order.filter((k) => o[k] !== undefined).map((k) => {
    if (k === 'action' || k === 'evidence' || k === 'history') return `${k}: >\n  ${String(o[k]).replace(/\n/g, '\n  ')}`
    return `${k}: ${typeof o[k] === 'number' ? o[k] : q(o[k])}`
  }).join('\n') + '\n'
}

function dirFor(slug) { return path.join(LEARN(), slug) }

export function list(slug, { includeSquad = true } = {}) {
  const out = []
  const read = (dir, origin) => {
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      try { out.push({ ...parseYaml(fs.readFileSync(path.join(dir, f), 'utf8')), _file: path.join(dir, f), _origin: origin }) } catch {}
    }
  }
  read(dirFor(slug), 'forge')
  if (includeSquad) read(path.join(SQUAD(), slug), 'squad (read-only)')
  return out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
}

// Prompt block injected at intake, clarify, matrix building and every lane prompt.
export function promptBlock(slug, minConf = 0.5, max = 8) {
  const ins = list(slug).filter((i) => (i.confidence || 0) >= minConf).slice(0, max)
  if (!ins.length) return ''
  return ['Learned instincts for this repo (verified in earlier runs; confidence in brackets):',
    ...ins.map((i) => `- [${Number(i.confidence).toFixed(1)}] ${i.trigger}: ${i.action}${i._origin !== 'forge' ? ` (from ${i._origin})` : ''}`)].join('\n')
}

function stamp() { return new Date().toISOString().slice(0, 10) }

function writeInstinct(slug, ins) {
  const dir = dirFor(slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${ins.id}.yaml`), toYaml(ins))
}

function get(slug, id) {
  const p = path.join(dirFor(slug), `${id}.yaml`)
  return fs.existsSync(p) ? parseYaml(fs.readFileSync(p, 'utf8')) : null
}

export function mutate(slug, id, delta, why) {
  const ins = get(slug, id)
  if (!ins) return null
  const from = Number(ins.confidence)
  const to = Math.round(Math.min(0.9, Math.max(0, from + delta)) * 100) / 100
  const p = path.join(dirFor(slug), `${id}.yaml`)
  if (to < DELETE_BELOW) { fs.unlinkSync(p); return { id, from, to, deleted: true, why } }
  ins.confidence = to
  ins.updated = stamp()
  ins.history = `${ins.history ? ins.history + ' | ' : ''}${stamp()} ${from} to ${to} ${why}`
  writeInstinct(slug, ins)
  return { id, from, to, why }
}

// capture or confirm: an existing id is a confirmation (+0.1), never a duplicate file.
export function capture(slug, { id, trigger, action, domain, source, evidence, confidence }) {
  const existing = get(slug, id)
  if (existing) return { ...mutate(slug, id, +0.1, `confirmed: ${evidence}`), kind: 'confirm' }
  writeInstinct(slug, {
    id, trigger, confidence: confidence ?? 0.5, domain, source, scope: 'repo', repo: slug,
    created: stamp(), action, evidence,
  })
  return { id, to: confidence ?? 0.5, kind: 'capture' }
}

export function correction(slug, text) {
  const id = `correction-${sha256(text).slice(0, 8)}`
  return capture(slug, { id, trigger: `when working in ${slug}`, action: text, domain: 'workflow', source: 'human-correction', evidence: 'owner correction', confidence: 0.8 })
}

// Derive at most two lessons from a finished run. Every lesson cites run evidence;
// nothing is sourced from ticket text or an agent's self-report.
export function harvest(slug, { goal, iterations, base, finalEval }) {
  const out = []
  const applied = []
  // 1) The test command, confirmed only when it actually ran green at the end.
  if (finalEval?.suite_green && goal.test_cmd) {
    const id = `test-cmd-${sha256(goal.test_cmd).slice(0, 8)}`
    out.push({ id, trigger: `when running the test suite in ${slug}`, action: `use: ${goal.test_cmd}`, domain: 'testing', source: 'session-observation', evidence: `suite green at final iteration (${finalEval.ac_pass}/${finalEval.ac_total} acceptance)` })
    // contradiction: other forge test-cmd instincts for this repo whose command was not this one
    for (const i of list(slug, { includeSquad: false })) {
      if (String(i.id).startsWith('test-cmd-') && i.id !== id) applied.push(mutate(slug, i.id, -0.2, `contradicted: suite green with a different command`))
    }
  }
  // 2) Failure pattern: same first error line in >=2 discarded iterations, later resolved.
  const counts = new Map()
  for (const it of iterations.filter((x) => x.verdict === 'discard' && x.first_error)) counts.set(it.first_error, (counts.get(it.first_error) || 0) + 1)
  const recurring = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]
  if (recurring && finalEval?.done) {
    out.push({ id: `fail-${sha256(recurring[0]).slice(0, 8)}`, trigger: `when changing code in ${slug} and seeing "${recurring[0].slice(0, 80)}"`, action: `this failure repeated ${recurring[1]}x before it was fixed; check its root cause before retrying`, domain: 'debugging', source: 'fix-loop', evidence: `${recurring[1]} discarded iterations with the same first error` })
  }
  // 3) A case (edge/unhappy/regression) that was green in the kept state and went red in a
  //    candidate iteration: it caught a real break, so it is worth keeping in future matrices.
  const caught = new Map()
  for (const it of iterations) for (const c of it.caught || []) caught.set(`${c.kind}:${c.id}`, (caught.get(`${c.kind}:${c.id}`) || 0) + 1)
  const top = [...caught.entries()].sort((a, b) => b[1] - a[1])[0]
  if (top) out.push({ id: `edge-${sha256(top[0]).slice(0, 8)}`, trigger: `when building the test matrix in ${slug}`, action: `keep case ${top[0]} (or its class) in the matrix: it caught ${top[1]} break(s) during the loop`, domain: 'testing', source: 'fix-loop', evidence: `went red after being green in ${top[1]} iteration(s)` })

  const captured = out.slice(0, MAX_CAPTURE).map((l) => capture(slug, l))
  return { captured, mutated: applied.filter(Boolean) }
}
