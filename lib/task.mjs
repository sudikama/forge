// Task model: one directory per task under <repo>/.forge/tasks/<KEY>/, a state machine,
// validators for every artifact, and the lock that freezes goal/spec/scope/worklist/matrix.
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson, now, sha256File, matchAny, run, repoRoot, repoSlug, git } from './util.mjs'

export const STATES = ['INTAKE', 'SPEC', 'SCOPED', 'PLANNED', 'CLARIFY', 'READY', 'RUNNING', 'PAUSED', 'DONE', 'STOPPED', 'ESCALATED']
export const TERMINAL = ['DONE', 'STOPPED', 'ESCALATED']
export const LOCKED_ARTIFACTS = ['goal.json', 'spec.md', 'scope.json', 'worklist.json', 'lanes.json', 'matrix.json', 'clarify.json', 'baseline.json']

export function forgeDir(root) { return path.join(root, '.forge') }
export function taskDir(root, key) { return path.join(forgeDir(root), 'tasks', key) }

export function ensureExcluded(root) {
  const ex = path.join(root, '.git', 'info', 'exclude')
  if (!fs.existsSync(path.join(root, '.git'))) return
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''
  const add = ['.forge/', '.forge-lane'].filter((l) => !cur.split('\n').includes(l))
  if (add.length) fs.appendFileSync(ex, (cur.endsWith('\n') || !cur ? '' : '\n') + add.join('\n') + '\n')
}

export function activeKey(root) {
  const p = path.join(forgeDir(root), 'active')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null
}

export function setActive(root, key) {
  fs.mkdirSync(forgeDir(root), { recursive: true })
  fs.writeFileSync(path.join(forgeDir(root), 'active'), key ? key + '\n' : '')
}

export function loadTask(root, key = activeKey(root)) {
  if (!key) return null
  const dir = taskDir(root, key)
  const t = readJson(path.join(dir, 'task.json'), null)
  if (!t) return null
  return { ...t, dir, root }
}

export function saveTask(t) {
  const { dir, root, ...data } = t
  data.updated = now()
  writeJson(path.join(dir, 'task.json'), data)
}

export function art(t, name) { return path.join(t.dir, name) }
export function readArt(t, name, fallback = null) {
  const p = art(t, name)
  if (!fs.existsSync(p)) return fallback
  return name.endsWith('.json') ? readJson(p, fallback) : fs.readFileSync(p, 'utf8')
}

export function event(t, text) {
  fs.appendFileSync(art(t, 'ledger.md'), `- ${now()} ${text}\n`)
}

export function createTask(root, { key, mode, title, reportTo, sources }) {
  ensureExcluded(root)
  const dir = taskDir(root, key)
  if (fs.existsSync(path.join(dir, 'task.json'))) throw new Error(`task ${key} already exists`)
  fs.mkdirSync(path.join(dir, 'source'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'iterations'), { recursive: true })
  const head = run(['git', 'rev-parse', 'HEAD'], { cwd: root })
  const branch = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
  const t = {
    key, mode, title: title || key, state: mode === 'small' ? 'RUNNING' : 'INTAKE', slug: repoSlug(root),
    created: now(), base_commit: head.code === 0 ? head.stdout.trim() : null,
    base_branch: branch.code === 0 ? branch.stdout.trim() : null,
    loop_branch: `forge/${key}`, report_to: reportTo || [], sources: sources || [],
    iteration: 0, best: null, plateau: 0, stalls: 0, lock: null, small: null,
  }
  saveTask({ ...t, dir, root })
  setActive(root, key)
  fs.writeFileSync(path.join(dir, 'ledger.md'), `# ledger ${key}\n`)
  return loadTask(root, key)
}

export function setState(t, state, why) {
  if (!STATES.includes(state)) throw new Error(`bad state ${state}`)
  const from = t.state
  t.state = state
  saveTask(t)
  event(t, `state ${from} to ${state}${why ? ` (${why})` : ''}`)
}

// ---------- validators: each returns a list of problems (empty = valid) ----------

export function checkSources(t) {
  const p = []
  if (!t.sources.length) p.push('no source registered: add the Jira ticket / Google Doc / PDF / markdown / PRD / Figma the task comes from (forge source add)')
  for (const s of t.sources) if (!fs.existsSync(path.join(t.dir, 'source', s.file))) p.push(`source file missing: source/${s.file}`)
  return p
}

export function checkGoal(t) {
  const g = readArt(t, 'goal.json')
  const p = []
  if (!g) return ['goal.json missing (template: forge template goal)']
  if (!g.objective) p.push('goal.objective empty')
  if (!g.test_cmd) p.push('goal.test_cmd empty: green tests are mandatory')
  const m = g.metric || {}
  if (!m.cmd) p.push('goal.metric.cmd empty: the ratchet needs a number')
  if (!['min', 'max'].includes(m.direction)) p.push('goal.metric.direction must be "min" or "max"')
  if (typeof m.target !== 'number') p.push('goal.metric.target must be a number')
  const b = g.budget || {}
  for (const k of ['max_iterations', 'max_minutes', 'plateau_n']) if (!(Number(b[k]) > 0)) p.push(`goal.budget.${k} must be > 0`)
  if (!Array.isArray(g.editable) || !g.editable.length) p.push('goal.editable must list the globs the loop may change')
  if (!Array.isArray(g.locked) || !g.locked.length) p.push('goal.locked must list the evaluator/test files the loop may never touch')
  return p
}

const SPEC_SECTIONS = ['Problem', 'Goals', 'Non-goals', 'Requirements', 'Acceptance Criteria', 'Test Seams', 'Edge Cases', 'Constraints', 'Open Questions', 'Task Breakdown', 'Assumptions']

export function specACs(spec) {
  const out = []
  const re = /^\s*-\s*\[[ x]\]\s*(AC-\d+)\s*:\s*(.+)$/gm
  let m
  while ((m = re.exec(spec || ''))) {
    const src = m[2].match(/\(source:\s*([^)]+)\)/i)
    out.push({ id: m[1], text: m[2].trim(), source: src ? src[1].trim() : null })
  }
  return out
}

export function checkSpec(t) {
  const s = readArt(t, 'spec.md')
  if (!s) return ['spec.md missing (template: forge template spec)']
  const p = []
  for (const sec of SPEC_SECTIONS) {
    const m = s.match(new RegExp(`^##+\\s*${sec.replace('-', '\\-')}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'))
    if (!m) p.push(`spec section missing: ${sec}`)
    else if (!m[1].replace(/<!--[\s\S]*?-->/g, '').trim()) p.push(`spec section empty: ${sec} (write "none" + reason)`)
  }
  const acs = specACs(s)
  if (!acs.length) p.push('spec has no acceptance criteria (- [ ] AC-1: ... (source: ...))')
  for (const a of acs) if (!a.source) p.push(`${a.id} has no (source: ...) reference to the ticket/doc it came from`)
  return p
}

function exists(root, rel) { return fs.existsSync(path.join(root, rel.replace(/[#:].*$/, ''))) }

export function checkScope(t) {
  const sc = readArt(t, 'scope.json')
  if (!sc) return ['scope.json missing (template: forge template scope)']
  const p = []
  for (const k of ['in_scope', 'impacted', 'out_of_scope', 'conflicts']) if (!Array.isArray(sc[k])) p.push(`scope.${k} must be an array (empty is allowed, absent is not)`)
  if (p.length) return p
  if (!sc.in_scope.length) p.push('scope.in_scope is empty')
  const acs = specACs(readArt(t, 'spec.md', '')).map((a) => a.id)
  const covered = new Set()
  for (const e of sc.in_scope) {
    if (!e.path) { p.push('in_scope entry without path'); continue }
    if (!e.new && !exists(t.root, e.path)) p.push(`in_scope path does not exist (mark "new": true if it will be created): ${e.path}`)
    if (!e.evidence && !e.new) p.push(`in_scope ${e.path} has no evidence (file:line)`)
    for (const a of e.ac || []) covered.add(a)
  }
  for (const a of acs) if (!covered.has(a)) p.push(`${a} is not mapped to any in_scope path`)
  for (const e of sc.impacted) {
    if (!e.path || !exists(t.root, e.path)) p.push(`impacted path does not exist: ${e.path}`)
    if (!e.evidence) p.push(`impacted ${e.path} has no evidence (who calls it, file:line)`)
    if (!('tests' in e)) p.push(`impacted ${e.path} must say which tests cover it ("tests": [] if none)`)
  }
  for (const c of sc.conflicts) if (!c.id || !c.evidence || !(c.options || []).length) p.push(`conflict ${c.id || '?'} needs id, evidence and options`)
  return p
}

export function checkMatrix(t) {
  const mx = readArt(t, 'matrix.json')
  if (!mx) return ['matrix.json missing (template: forge template matrix)']
  const p = []
  const cases = mx.cases || []
  const acs = specACs(readArt(t, 'spec.md', '')).map((a) => a.id)
  const by = (kind, src) => cases.filter((c) => c.kind === kind && (!src || c.source === src))
  for (const a of acs) {
    if (!by('happy', a).length) p.push(`${a}: no happy-path case`)
    for (const kind of ['unhappy', 'edge']) {
      if (!by(kind, a).length && !(mx.waivers || []).some((w) => w.ac === a && w.kind === kind && w.reason)) p.push(`${a}: no ${kind} case (or waiver with reason)`)
    }
  }
  const sc = readArt(t, 'scope.json', { impacted: [] })
  for (const imp of sc.impacted || []) {
    if (!cases.some((c) => c.kind === 'regression' && (c.covers || []).includes(imp.path))) p.push(`impacted ${imp.path}: no regression case covers it (existing test or characterization test)`)
  }
  for (const c of cases) {
    if (!c.id || !c.kind || !c.expect) p.push(`case ${c.id || '?'} needs id, kind, expect`)
    if (!['happy', 'unhappy', 'edge', 'regression'].includes(c.kind)) p.push(`case ${c.id}: kind must be happy|unhappy|edge|regression`)
  }
  return p
}

export function checkWorklist(t) {
  const w = readArt(t, 'worklist.json')
  if (!w) return ['worklist.json missing (template: forge template worklist)']
  const p = []
  const ids = new Set()
  for (const it of w.items || []) {
    if (!it.id || ids.has(it.id)) p.push(`worklist item id missing or duplicate: ${it.id}`)
    ids.add(it.id)
    if (!(it.writes || []).length) p.push(`${it.id}: writes[] empty (which files does this slice own?)`)
    if (!['S', 'M', 'L'].includes(it.size)) p.push(`${it.id}: size must be S|M|L`)
  }
  for (const it of w.items || []) for (const d of it.depends_on || []) if (!ids.has(d)) p.push(`${it.id}: depends_on unknown item ${d}`)
  if (!(w.items || []).length) p.push('worklist has no items')
  return p
}

export function checkClarify(t) {
  const c = readArt(t, 'clarify.json')
  if (!c) return ['clarify not generated (forge clarify)']
  return (c.questions || []).filter((q) => q.answer === undefined || q.answer === null || q.answer === '').map((q) => `${q.id} unanswered: ${q.question}`)
}

// ---------- lock ----------

export function lockFiles(t) {
  const g = readArt(t, 'goal.json', {})
  const files = []
  for (const a of LOCKED_ARTIFACTS) if (fs.existsSync(art(t, a))) files.push(path.relative(t.root, art(t, a)))
  const tracked = run(['git', 'ls-files'], { cwd: t.root }).stdout.split('\n').filter(Boolean)
  for (const f of tracked) if (matchAny(f, g.locked || [])) files.push(f)
  const base = readArt(t, 'baseline.json', {})
  for (const f of base.characterization || []) if (!files.includes(f)) files.push(f)
  return [...new Set(files)]
}

export function computeLock(t) {
  const hashes = {}
  for (const f of lockFiles(t)) {
    const abs = path.join(t.root, f)
    hashes[f] = fs.existsSync(abs) ? sha256File(abs) : 'MISSING'
  }
  return hashes
}

export function verifyLock(t) {
  if (!t.lock) return []
  const bad = []
  for (const [f, h] of Object.entries(t.lock.hashes)) {
    const abs = path.join(t.root, f)
    const cur = fs.existsSync(abs) ? sha256File(abs) : 'MISSING'
    if (cur !== h) bad.push(f)
  }
  return bad
}

export function isProtected(t, rel) {
  if (!t || !t.lock) return false
  const r = rel.replace(/^\.\//, '')
  if (r in t.lock.hashes) return true
  const g = readArt(t, 'goal.json', {})
  return matchAny(r, g.locked || [])
}

export function rootOf(cwd) { return repoRoot(cwd) }
export { git }
