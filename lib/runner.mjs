// Large-task loop: orchestrator + lanes (subagents in their own git worktrees) + an
// independent deterministic judge, ratcheting one integration branch like autoresearch:
// an iteration is kept only when it is green, regression-free and better; otherwise reset.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PLUGIN_ROOT, readJson, writeJson, run, git, now, sha256File, matchAny, option, tail } from './util.mjs'
import { loadTask, saveTask, setState, event, readArt, art, TERMINAL } from './task.mjs'
import { evaluate, classifyFailure, firstErrorLine, writeIterLog, better, runCase } from './judge.mjs'
import { ask, choice, noul } from './jev.mjs'
import * as learn from './learn.mjs'
import { route, updateLadder, failLimit, ladderSummary } from './route.mjs'
import { deliver } from './io.mjs'
import { writeReport } from './report.mjs'

const POLICY = {
  noted: ['preexisting_bug', 'refactor_idea', 'out_of_scope'],
  blocked: ['new_requirement', 'contract_change', 'data_security', 'irreversible'],
  decide: ['spec_gap', 'ambiguity', 'dependency', 'shared_file_change', 'ownership', 'other'],
  rejected: ['lock_violation'],
}
export const FINDING_KINDS = [...POLICY.noted, ...POLICY.blocked, ...POLICY.decide, ...POLICY.rejected]

export function wtDir(t, name) { return path.join(t.root, '.forge', 'wt', t.key, name) }
export function control(t) { const p = art(t, 'control'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : 'run' }

function ensureWorktree(t, name, branch, at, meta = {}) {
  const dir = wtDir(t, name)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    git(['worktree', 'add', '-f', '-B', branch, dir, at], t.root)
  } else {
    git(['checkout', '-f', '-B', branch, at], dir)
    git(['reset', '--hard', at], dir)
    git(['clean', '-fdq'], dir)
  }
  const locked = [...new Set([...(readArt(t, 'goal.json', {}).locked || []), ...Object.keys(t.lock?.hashes || {}).filter((f) => !f.startsWith('.forge/'))])]
  fs.writeFileSync(path.join(dir, '.forge-lane'), JSON.stringify({ task_dir: t.dir, lane: name, key: t.key, role: meta.role || 'lane', owns: meta.owns || [], locked }) + '\n')
  return dir
}

function commitAll(dir, msg) {
  run(['git', 'add', '-A'], { cwd: dir })
  const st = run(['git', 'diff', '--cached', '--quiet'], { cwd: dir })
  if (st.code === 0) return null
  const r = run(['git', '-c', 'user.name=forge', '-c', 'user.email=forge@localhost', 'commit', '-q', '--no-verify', '-m', msg], { cwd: dir })
  if (r.code !== 0) throw new Error(`commit failed: ${r.stderr}`)
  return git(['rev-parse', 'HEAD'], dir)
}

// ---------- agents ----------

function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? '')) }

function agentArgv(promptFile, { maxTurns, rt }) {
  const argv = ['claude', '-p', '--plugin-dir', PLUGIN_ROOT, '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash', '--max-turns', String(maxTurns), '--output-format', 'json']
  if (rt?.model) argv.push('--model', rt.model)
  if (rt?.effort) argv.push('--effort', rt.effort)
  return argv
}

function runAgent({ t, role, lane, tag, cwd, prompt, iter, timeoutMin, maxTurns, rt }) {
  const dir = path.join(t.dir, 'agents')
  fs.mkdirSync(dir, { recursive: true })
  const stem = `${String(iter).padStart(4, '0')}-${role}${lane ? '-' + lane : ''}${tag ? '-' + tag : ''}`
  const promptFile = path.join(dir, `${stem}.prompt.md`)
  const logFile = path.join(dir, `${stem}.log`)
  fs.writeFileSync(promptFile, prompt)
  const env = { ...process.env, FORGE_ROLE: role, FORGE_LANE: lane || '', FORGE_TASK_DIR: t.dir, FORGE_WORKTREE: cwd, FORGE_PROMPT_FILE: promptFile, FORGE_ITER: String(iter), FORGE_MODEL: rt?.model || '', FORGE_EFFORT: rt?.effort || '' }
  const custom = process.env.FORGE_AGENT_CMD || option('agentCmd', '')
  const argv = custom ? ['bash', '-lc', custom] : agentArgv(promptFile, { maxTurns, rt })
  if (rt) fs.writeFileSync(path.join(dir, `${stem}.route.json`), JSON.stringify(rt, null, 2))
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w')
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: [custom ? 'ignore' : fs.openSync(promptFile, 'r'), out, out], detached: true })
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, timeoutMin * 60 * 1000)
    child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ role, lane, code: code ?? (signal ? 124 : 1), log: logFile, rt }) })
  })
}

// ---------- findings + orchestrator ----------

export function findingsDir(t) { return path.join(t.dir, 'findings') }

export function listFindings(t) {
  const d = findingsDir(t)
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f))).sort((a, b) => a.id.localeCompare(b.id))
}

export function addFinding(taskDir, f) {
  const d = path.join(taskDir, 'findings')
  fs.mkdirSync(d, { recursive: true })
  const n = fs.readdirSync(d).filter((x) => x.endsWith('.json')).length + 1
  const id = `F-${String(n).padStart(3, '0')}`
  if (!FINDING_KINDS.includes(f.kind)) throw new Error(`finding kind must be one of: ${FINDING_KINDS.join(', ')}`)
  for (const k of ['title', 'evidence']) if (!f[k]) throw new Error(`finding needs --${k}`)
  const row = { id, status: 'open', created: now(), ...f }
  writeJson(path.join(d, `${id}.json`), row)
  return row
}

// A decision is valid only when it cites a line that exists in the locked spec/goal/clarify.
export function validCite(t, cite) {
  if (!cite || typeof cite !== 'string') return false
  let m = cite.match(/^spec\.md:L?(\d+)$/i)
  if (m) { const lines = (readArt(t, 'spec.md', '') || '').split('\n'); const l = lines[Number(m[1]) - 1]; return !!(l && l.trim() && !/^#/.test(l.trim())) }
  m = cite.match(/^goal(?:\.json)?:([\w.]+)$/i)
  if (m) { let v = readArt(t, 'goal.json', {}); for (const k of m[1].split('.')) v = v?.[k]; return v !== undefined && v !== null && v !== '' }
  m = cite.match(/^clarify:([\w-]+)$/i)
  if (m) return !!(readArt(t, 'clarify.json', { questions: [] }).questions.find((q) => q.id === m[1] && q.answer))
  m = cite.match(/^scope:(in_scope|out_of_scope|impacted):(.+)$/i)
  if (m) return !!(readArt(t, 'scope.json', {})[m[1]] || []).find((e) => e.path === m[2] || e.item === m[2])
  return false
}

async function jevPresort(t, f) {
  const spec = (readArt(t, 'spec.md', '') || '').slice(0, 8000)
  const r = await ask({ spec, finding: { kind: f.kind, title: f.title, evidence: String(f.evidence).slice(0, 2000) } }, {
    fit: choice('Given the spec, is acting on this finding within the agreed scope?', {
      in_scope: 'the spec already requires or clearly permits it',
      out_of_scope: 'the spec excludes it or it is a different piece of work',
      unclear: 'the spec does not settle it either way',
    }),
  }, { purpose: 'finding-presort' })
  return r.answers?.fit ? { fit: r.answers.fit.choice, confidence: r.answers.fit.confidence, lane: r.lane } : null
}

// Hybrid decision, Jev first: a finding Jev places out of scope with high confidence is rejected
// WITHOUT an LLM call, but only when Jev also grounds it in a concrete exclusion line (Non-goals,
// MUST NOT, scope.out_of_scope). Everything else goes to the Claude orchestrator.
export function exclusionLines(t) {
  const out = []
  const lines = (readArt(t, 'spec.md', '') || '').split('\n')
  let sec = ''
  lines.forEach((l, i) => {
    const h = l.match(/^##+\s*(.+?)\s*$/)
    if (h) { sec = h[1].toLowerCase(); return }
    const txt = l.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/, '').trim()
    if (!txt || txt === 'none' || txt.startsWith('<!--')) return
    if (sec === 'non-goals' || /\bMUST NOT\b/.test(l)) out.push({ cite: `spec.md:L${i + 1}`, text: txt })
  })
  for (const e of readArt(t, 'scope.json', {}).out_of_scope || []) if (e.item) out.push({ cite: `scope:out_of_scope:${e.item}`, text: `${e.item}${e.why ? ` (${e.why})` : ''}` })
  return out.slice(0, 12)
}

// Calibrated on zen (6 findings): the "which exclusion, or none" choice never rejected a real
// gap (none at 1.00), but true matches only reach 0.40-0.49, so on zen this rarely fires and the
// finding goes to Claude. The bar is a config so a calibrated lane (typesafe) can use it more.
export async function jevDecide(t, f) {
  if (option('jevDecide', 'true') === 'false') return null
  const cands = exclusionLines(t)
  if (!cands.length) return null
  const crit = Object.fromEntries(cands.map((c, i) => [`x${i}`, `the finding is about exactly this excluded work: ${c.text}`]))
  crit.none = 'no listed exclusion covers it; it may be required, a gap, or unrelated'
  const r = await ask({ finding: { kind: f.kind, title: f.title, evidence: String(f.evidence).slice(0, 1500) } },
    { which: choice('Which listed spec exclusion, if any, covers this finding?', crit) }, { purpose: 'finding-decide' })
  const w = r.answers?.which
  if (!w) return null
  const bar = Number(option('jevRejectBar', 0.6))
  const pick = w.choice === 'none' ? null : cands[Number(w.choice.slice(1))]
  const trace = { jev: `${w.choice}:${w.confidence.toFixed(2)}`, bar, lane: r.lane }
  if (!pick || w.confidence < bar || !validCite(t, pick.cite)) return { ...trace, deferred: true }
  return { ...trace, decision: 'reject', cite: pick.cite, reason: `excluded by "${pick.text}" (jev ${w.confidence.toFixed(2)} >= ${bar})` }
}

async function orchestrate(t, iter, integDir, budget) {
  const decided = []
  for (const f of listFindings(t).filter((x) => x.status === 'open')) {
    const p = path.join(findingsDir(t), `${f.id}.json`)
    f.presort = await jevPresort(t, f)
    if (POLICY.rejected.includes(f.kind)) {
      Object.assign(f, { status: 'rejected', decision: { by: 'policy', cite: 'goal:locked', reason: 'locked evaluator/test files never change inside the loop; the lane change was dropped' } })
    } else if (POLICY.noted.includes(f.kind)) {
      Object.assign(f, { status: 'noted', decision: { by: 'policy', rule: `${f.kind} is reported as a new-ticket proposal, not worked on` } })
    } else if (POLICY.blocked.includes(f.kind)) {
      Object.assign(f, { status: 'blocked', decision: { by: 'policy', rule: `${f.kind} is outside the orchestrator's authority (clarify G1)` } })
    } else if ((f.jev = await jevDecide(t, f))?.decision) {
      Object.assign(f, { status: 'rejected', decision: { decision: 'reject', cite: f.jev.cite, reason: f.jev.reason, by: 'jev' } })
    } else {
      const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'orchestrator-prompt.md'), 'utf8')
      const out = path.join(t.dir, 'decisions', `${f.id}.json`)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      const prompt = fill(tpl, {
        KEY: t.key, FINDING: JSON.stringify(f, null, 2), DECISION_FILE: out, TASK_DIR: t.dir,
        SPEC: numbered(readArt(t, 'spec.md', '')), GOAL: JSON.stringify(readArt(t, 'goal.json', {}), null, 2),
        CLARIFY: JSON.stringify((readArt(t, 'clarify.json', { questions: [] }).questions || []).map((q) => ({ id: q.id, q: q.question, answer: q.answer })), null, 2),
        SCOPE: JSON.stringify(readArt(t, 'scope.json', {}), null, 2).slice(0, 12000),
        INTEGRATOR_OWNS: (readArt(t, 'lanes.json', { integrator: { owns: [] } }).integrator?.owns || []).join(', ') || '(none)',
      })
      const rt = await route({ role: 'orchestrator', items: [{ id: `orch-${f.id}`, size: 'M', title: `${f.kind}: ${f.title}` }] })
      const r = await runAgent({ t, role: 'orchestrator', tag: f.id, cwd: integDir, prompt, iter, timeoutMin: budget.lane_timeout_min || 30, maxTurns: 40, rt })
      f.route = { model: rt.model, effort: rt.effort, why: rt.why }
      const d = fs.existsSync(out) ? readJson(out, null) : null
      if (!d || !['proceed', 'reject', 'blocked'].includes(d.decision)) {
        Object.assign(f, { status: 'blocked', decision: { by: 'orchestrator', invalid: true, rule: `no valid decision file (agent exit ${r.code})` } })
      } else if (d.decision !== 'blocked' && !validCite(t, d.cite)) {
        Object.assign(f, { status: 'blocked', decision: { ...d, by: 'orchestrator', invalid: true, rule: `cite "${d.cite}" does not resolve to a line of spec/goal/clarify/scope` } })
      } else {
        Object.assign(f, { status: d.decision === 'proceed' ? 'decided' : d.decision === 'reject' ? 'rejected' : 'blocked', decision: { ...d, by: 'orchestrator' } })
      }
    }
    f.decided_at = now()
    writeJson(p, f)
    event(t, `finding ${f.id} (${f.kind}) is ${f.status}${f.decision?.cite ? ` cite ${f.decision.cite}` : ''}${f.decision?.rule ? `: ${f.decision.rule}` : ''}`)
    decided.push(f)
  }
  // Blocked findings tied to an item block that item; the loop continues with the rest.
  const wl = readArt(t, 'worklist.json')
  let changed = false
  for (const f of decided.filter((x) => x.status === 'blocked' && x.item)) {
    const it = (wl.items || []).find((i) => i.id === f.item)
    if (it && it.status !== 'blocked') { it.status = 'blocked'; it.blocked_by = f.id; changed = true }
  }
  if (changed) writeJson(art(t, 'worklist-state.json'), { items: wl.items.map((i) => ({ id: i.id, status: i.status || 'open', blocked_by: i.blocked_by })) })
  return decided
}

function numbered(text) { return String(text).split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n') }

// ---------- item bookkeeping ----------

export function itemState(t) {
  const wl = readArt(t, 'worklist.json', { items: [] })
  const st = readArt(t, 'worklist-state.json', { items: [] })
  const m = new Map((st.items || []).map((i) => [i.id, i]))
  return wl.items.map((i) => ({ ...i, status: m.get(i.id)?.status || 'open', blocked_by: m.get(i.id)?.blocked_by }))
}

function saveItemState(t, items) {
  writeJson(art(t, 'worklist-state.json'), { items: items.map((i) => ({ id: i.id, status: i.status, blocked_by: i.blocked_by })) })
}

function markDone(t, items, ev) {
  const passing = new Set()
  const failing = new Set(ev.failing.map((f) => f.id))
  const matrix = readArt(t, 'matrix.json', { cases: [] })
  for (const c of matrix.cases) if (!failing.has(c.id)) passing.add(c.id)
  for (const it of items) {
    if (it.status === 'blocked' || it.status === 'done') continue
    const cases = it.cases || matrix.cases.filter((c) => (c.items || []).includes(it.id)).map((c) => c.id)
    if (cases.length && cases.every((c) => passing.has(c))) it.status = 'done'
  }
  saveItemState(t, items)
}

// ---------- ownership + lock checks on a lane's commit ----------

function changedFiles(dir, from, to) {
  return git(['diff', '--name-only', `${from}..${to}`], dir).split('\n').filter(Boolean)
}

function lockedRepoFiles(t) { return Object.keys(t.lock?.hashes || {}).filter((f) => !f.startsWith('.forge/')) }

export function lockViolations(t, dir) {
  const bad = []
  for (const f of lockedRepoFiles(t)) {
    const abs = path.join(dir, f)
    const cur = fs.existsSync(abs) ? sha256File(abs) : 'MISSING'
    if (cur !== t.lock.hashes[f]) bad.push(f)
  }
  return bad
}

// ---------- the loop ----------

export async function runLoop(root, key) {
  let t = loadTask(root, key)
  if (!t) throw new Error(`no task ${key}`)
  if (!['READY', 'RUNNING', 'PAUSED'].includes(t.state)) throw new Error(`task is ${t.state}; lock it first (forge lock)`)
  const goal = readArt(t, 'goal.json')
  const matrix = readArt(t, 'matrix.json')
  const base = readArt(t, 'baseline.json')
  const lanes = readArt(t, 'lanes.json')
  const budget = { lane_timeout_min: 30, lane_max_turns: 60, ...(goal.budget || {}) }
  const workers = Number(t.workers || lanes.recommended_workers || 1)
  const started = t.loop_started ? Date.parse(t.loop_started) : Date.now()
  if (!t.loop_started) { t.loop_started = new Date(started).toISOString(); saveTask(t) }
  setState(t, 'RUNNING', `workers=${workers}`)
  fs.writeFileSync(art(t, 'control'), 'run\n')

  const integ = ensureWorktree(t, 'integ', t.loop_branch, t.lock.commit, { role: 'orchestrator', owns: lanes.integrator?.owns || [] })
  if (t.best?.commit) git(['reset', '--hard', t.best.commit], integ)
  const iterRows = readJson(art(t, 'iterations.json'), [])
  let stopReason = null
  let lastEval = t.best?.eval || null

  while (!stopReason) {
    t = loadTask(root, key)
    const ctl = control(t)
    if (ctl === 'stop') { stopReason = 'stopped by owner'; break }
    if (ctl === 'pause') { setState(t, 'PAUSED', 'control=pause'); return { paused: true } }
    if (t.iteration >= budget.max_iterations) { stopReason = `iteration budget ${budget.max_iterations} used`; break }
    if ((Date.now() - started) / 60000 >= budget.max_minutes) { stopReason = `time budget ${budget.max_minutes} min used`; break }
    if (t.plateau >= budget.plateau_n) { stopReason = `${budget.plateau_n} iterations without improvement`; break }
    const items = itemState(t)
    const open = items.filter((i) => i.status === 'open')
    if (!open.length) { stopReason = items.some((i) => i.status === 'blocked') ? 'every remaining item is blocked' : 'all items done but the goal is not met (see judge)'; break }

    const n = t.iteration + 1
    const head = git(['rev-parse', 'HEAD'], integ)
    const directives = listFindings(t).filter((f) => f.status === 'decided' && !f.applied)
    const failNote = lastEval && !lastEval.done ? `Last judge verdict: ${lastEval.verdict}. ${lastEval.why?.join('; ') || ''}\nFailure class: ${lastEval.failure_class?.cls || 'n/a'}\nFailing cases:\n${(lastEval.failing || []).slice(0, 6).map((f) => `- ${f.id} (${f.kind}): ${firstErrorLine(f.out)}`).join('\n')}` : 'First iteration.'
    const instincts = learn.promptBlock(t.slug)
    const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', 'lane-prompt.md'), 'utf8')
    const activeLanes = (lanes.lanes || []).slice(0, workers).map((l) => ({ ...l, todo: open.filter((i) => l.items.includes(i.id)) })).filter((l) => l.todo.length)
    // With fewer workers than planned lanes, fold the extra lanes' items into the active ones.
    if (workers < (lanes.lanes || []).length) {
      const extra = (lanes.lanes || []).slice(workers)
      extra.forEach((l, k) => { const tgt = activeLanes[k % Math.max(1, activeLanes.length)]; if (tgt) { tgt.todo.push(...open.filter((i) => l.items.includes(i.id))); tgt.owns = [...new Set([...tgt.owns, ...l.owns])] } })
    }
    event(t, `iter ${n}: ${activeLanes.length} lane(s), ${open.length} open item(s)`)

    const ladder = t.ladder || {}
    const routes = await Promise.all(activeLanes.map((l) => route({
      role: 'lane', items: l.todo, ladder,
      failureClass: lastEval && !lastEval.done ? lastEval.failure_class?.cls : null,
      firstError: lastEval?.failing?.[0] ? firstErrorLine(lastEval.failing[0].out) : '',
    })))
    const jobs = activeLanes.map((l, k) => {
      const dir = ensureWorktree(t, `lane-${l.lane}`, `${t.loop_branch}-lane-${l.lane}`, head, { role: 'lane', owns: l.owns })
      const prompt = fill(tpl, {
        KEY: t.key, LANE: l.lane, ITER: n, OBJECTIVE: goal.objective, TEST_CMD: goal.test_cmd, REGRESSION_CMD: goal.regression_cmd || '(none)',
        METRIC: `${goal.metric.name || goal.metric.cmd} (${goal.metric.direction} to ${goal.metric.target})`,
        ITEMS: l.todo.map((i) => `- ${i.id} [${i.size}] ${i.title}${i.ac ? ` (ACs: ${i.ac.join(', ')})` : ''}\n  writes: ${(i.writes || []).join(', ')}`).join('\n'),
        OWNS: l.owns.join('\n') || '(none)', LOCKED: (goal.locked || []).join('\n'),
        INTEGRATOR_OWNS: (lanes.integrator?.owns || []).join(', ') || '(none)',
        DIRECTIVES: directives.map((f) => `- ${f.id}: ${f.decision.instruction} (per ${f.decision.cite})`).join('\n') || '(none)',
        FAILURE: failNote, INSTINCTS: instincts || '(none yet)', SPEC_PATH: art(t, 'spec.md'), MATRIX_PATH: art(t, 'matrix.json'),
        TASK_DIR: t.dir, FORGE: `node ${path.join(PLUGIN_ROOT, 'bin', 'forge.mjs')}`,
      })
      return runAgent({ t, role: 'lane', lane: l.lane, cwd: dir, prompt, iter: n, timeoutMin: budget.lane_timeout_min, maxTurns: budget.lane_max_turns, rt: routes[k] }).then((r) => ({ ...r, dir, owns: l.owns, items: l.todo.map((i) => i.id) }))
    })
    const results = await Promise.all(jobs)
    for (const f of directives) { f.applied = n; writeJson(path.join(findingsDir(t), `${f.id}.json`), f) }

    // Integrate lane commits one by one; reject ownership/lock violations and merge conflicts.
    const laneNotes = []
    for (const r of results) {
      const c = commitAll(r.dir, `forge(${t.key}) iter ${n} lane ${r.lane}`)
      const tip = git(['rev-parse', 'HEAD'], r.dir)
      if (tip === head) { laneNotes.push(`${r.lane}: no change (exit ${r.code})`); continue }
      const files = changedFiles(r.dir, head, tip)
      const outside = files.filter((f) => !matchAny(f, r.owns))
      const locked = lockViolations(t, r.dir)
      if (locked.length) {
        laneNotes.push(`${r.lane}: REJECTED, touched locked files ${locked.join(', ')}`)
        addFinding(t.dir, { kind: 'lock_violation', title: `lane ${r.lane} modified locked files`, evidence: locked.join(', '), lane: r.lane, iter: n })
        continue
      }
      if (outside.length) {
        const patch = path.join(t.dir, 'agents', `${String(n).padStart(4, '0')}-lane-${r.lane}.outside.patch`)
        fs.writeFileSync(patch, run(['git', 'diff', `${head}..${tip}`, '--', ...outside], { cwd: r.dir }).stdout)
        laneNotes.push(`${r.lane}: REJECTED, wrote outside its ownership: ${outside.join(', ')}`)
        addFinding(t.dir, { kind: 'shared_file_change', title: `lane ${r.lane} needs changes outside its files`, evidence: `${outside.join(', ')}; patch: ${patch}`, lane: r.lane, iter: n, item: r.items[0] })
        continue
      }
      const m = run(['git', '-c', 'user.name=forge', '-c', 'user.email=forge@localhost', 'merge', '--no-ff', '--no-edit', '-q', `${t.loop_branch}-lane-${r.lane}`], { cwd: integ })
      if (m.code !== 0) { run(['git', 'merge', '--abort'], { cwd: integ }); laneNotes.push(`${r.lane}: merge conflict, dropped this iteration`); continue }
      laneNotes.push(`${r.lane}: merged ${files.length} file(s)`)
    }

    // Orchestrator: decide new findings (may edit integrator-owned files in integ).
    const decided = await orchestrate(t, n, integ, budget)
    commitAll(integ, `forge(${t.key}) iter ${n} integrator`)
    t = loadTask(root, key)

    // Judge, independently of every agent above.
    const lockBad = lockViolations(t, integ)
    let ev
    if (lockBad.length) ev = { verdict: 'discard', why: [`locked files changed: ${lockBad.join(', ')}`], done: false, failing: [], ac_pass: lastEval?.ac_pass ?? 0, ac_total: 0, regressions: [], metric: null }
    else if (git(['rev-parse', 'HEAD'], integ) === head) ev = { verdict: 'discard', why: ['no lane produced a mergeable change'], done: false, failing: lastEval?.failing || [], ac_pass: t.best?.ac_pass ?? 0, ac_total: lastEval?.ac_total ?? 0, regressions: [], metric: t.best?.metric ?? base.metric }
    else ev = evaluate({ goal, matrix, base, best: t.best, cwd: integ })
    if (ev.verdict === 'discard' || !ev.done) ev.failure_class = await classifyFailure(ev)
    // Cases green in the kept state that went red here caught a real break (feeds learning).
    const keptFailing = new Set((lastEval?.failing || []).map((f) => f.id))
    const caught = (ev.failing || []).filter((f) => !keptFailing.has(f.id) && (base.cases[f.id]?.pass || t.best)).map((f) => ({ id: f.id, kind: f.kind }))

    const routeNote = results.map((r) => `${r.lane}=${r.rt?.model}/${r.rt?.effort}${r.rt?.retry ? `#r${r.rt.retry}` : ''}`).join(' ')
    // Model ladder: every item a lane worked on either passed the gate or failed it. Failures count
    // per tier; at the tier's limit (haiku 1, sonnet 2, opus 2) the item climbs one tier; past the
    // top tier it is BLOCKED for the owner.
    const failingIds = new Set((ev.failing || []).map((x) => x.id))
    const mtx = readArt(t, 'matrix.json', { cases: [] })
    t.ladder = t.ladder || {}
    const ladderEvents = []
    const laneFate = new Map(laneNotes.map((nt) => [nt.split(':')[0], nt]))
    const ownRed = (id) => mtx.cases.filter((c) => (c.items || []).includes(id) && failingIds.has(c.id)).map((c) => c.id)
    const laneBad = (r) => /REJECTED|merge conflict|no change/.test(laneFate.get(r.lane) || '') || r.items.some((id) => ownRed(id).length)
    // Who broke the shared gate? On a discard with regressions or a red pre-existing suite and
    // more than one merged lane, re-run just the failing regression checks in each merged lane's
    // own worktree (base + that lane alone). A lane that is red on its own is the culprit.
    const merged = results.filter((r) => /merged/.test(laneFate.get(r.lane) || ''))
    const sharedRed = ev.verdict === 'discard' && ((ev.regressions || []).length || ev.regression_suite?.pass === false)
    const culprits = new Set()
    if (sharedRed && merged.length > 1) {
      const regCases = mtx.cases.filter((c) => (ev.regressions || []).includes(c.id))
      for (const r of merged) {
        const redAlone = regCases.some((c) => !runCase(c, r.dir).pass) || (ev.regression_suite?.pass === false && goal.regression_cmd && runCase({ id: 'regression_cmd', cmd: goal.regression_cmd }, r.dir).pass === false)
        if (redAlone) culprits.add(r.lane)
      }
      event(t, `iter ${n}: shared gate red; isolated re-run blames ${culprits.size ? [...culprits].join(', ') : 'no single lane (interaction)'}`)
    } else if (sharedRed && merged.length === 1) culprits.add(merged[0].lane)
    const culpritKnown = results.some(laneBad) || culprits.size > 0
    for (const r of results) for (const id of r.items) {
      const fate = laneFate.get(r.lane) || ''
      const reasons = []
      const red = ownRed(id)
      if (red.length) reasons.push(`cases red: ${red.join(', ')}`)
      if (/REJECTED|merge conflict|no change/.test(fate)) reasons.push(fate.replace(/^[^:]+:\s*/, ''))
      // Discarded (regression, suite red, no progress) with this item green and merged: it is to
      // blame only when no other lane is an identifiable culprit; otherwise it is not counted.
      const shared = ev.verdict === 'discard' && /merged/.test(fate) && !red.length
      if (shared && (culprits.has(r.lane) || !culpritKnown)) reasons.push(`iteration discarded: ${(ev.why || []).join('; ')}${culprits.has(r.lane) ? ' (red on this lane alone)' : ''}`)
      else if (shared) { t.ladder[id] = t.ladder[id] || { tier: r.rt?.tier || 'balanced', fails: 0, attempts: [] }; t.ladder[id].attempts.push({ iter: n, tier: r.rt?.tier, model: r.rt?.model, failed: false, why: 'green; discarded because of another lane (not counted)' }); continue }
      ladderEvents.push(...updateLadder(t.ladder, { item: id, tier: r.rt?.tier || 'balanced', model: r.rt?.model, iter: n, failed: reasons.length > 0, why: reasons.join(' | ') }))
    }
    const exhausted = ladderEvents.filter((e) => e.kind === 'exhausted')
    if (exhausted.length) {
      const st = itemState(t)
      for (const e of exhausted) {
        const it = st.find((i) => i.id === e.item)
        if (!it || it.status !== 'open') continue
        const tries = t.ladder[e.item].attempts.map((a) => `iter ${a.iter} ${a.model}${a.failed ? ' failed' : ''}`).join(', ')
        const f = addFinding(t.dir, { kind: 'other', item: e.item, iter: n, title: `${e.item} still fails the gate after every model tier`, evidence: `${tries}. Last gate result: ${e.why}`, options: ['clarify or split the item', 'change the spec or acceptance', 'fix it by hand'] })
        Object.assign(f, { status: 'blocked', decision: { by: 'policy', rule: `model ladder exhausted (fails allowed per tier: ${ladderSummary()})` } })
        writeJson(path.join(findingsDir(t), `${f.id}.json`), f)
        it.status = 'blocked'; it.blocked_by = f.id
        decided.push(f)
      }
      saveItemState(t, st)
    }
    for (const e of ladderEvents) {
      if (e.kind === 'escalate') event(t, `ladder: ${e.item} escalates ${e.from} -> ${e.to} after ${e.n} gate failure(s)`)
      if (e.kind === 'exhausted') event(t, `ladder: ${e.item} exhausted every tier, BLOCKED`)
    }
    const row = { iter: n, at: now(), head_before: head, routes: results.map((r) => ({ lane: r.lane, items: r.items, tier: r.rt?.tier, model: r.rt?.model, effort: r.rt?.effort, retry: r.rt?.retry || 0, source: r.rt?.source, why: r.rt?.why })), ladder: ladderEvents, verdict: ev.verdict, why: ev.why, ac: `${ev.ac_pass}/${ev.ac_total}`, metric: ev.metric, regressions: ev.regressions, lanes: laneNotes, findings: decided.map((f) => `${f.id}:${f.status}`), failure_class: ev.failure_class?.cls || null, first_error: ev.failing?.[0] ? firstErrorLine(ev.failing[0].out) : null, caught }
    if (ev.verdict === 'keep') {
      const commit = git(['rev-parse', 'HEAD'], integ)
      t.best = { commit, metric: ev.metric, ac_pass: ev.ac_pass, iter: n, eval: { ...ev, suite_out: undefined } }
      t.plateau = 0
      row.commit = commit
      markDone(t, itemState(t), ev)
      lastEval = ev
    } else {
      git(['reset', '--hard', t.best?.commit || head], integ)
      git(['clean', '-fdq'], integ)
      t.plateau += 1
      lastEval = { ...ev, failing: ev.failing }
    }
    t.iteration = n
    saveTask(t)
    iterRows.push(row)
    writeJson(art(t, 'iterations.json'), iterRows)
    writeIterLog(t.dir, n, { ...row, eval: ev })
    fs.appendFileSync(art(t, 'results.tsv'), (fs.existsSync(art(t, 'results.tsv')) ? '' : 'iter\tcommit\tmetric\tac\tstatus\troutes\tdescription\n') + `${n}\t${(row.commit || '').slice(0, 7)}\t${ev.metric ?? ''}\t${row.ac}\t${ev.verdict}\t${routeNote}\t${(ev.why || []).join('; ').replace(/\t/g, ' ') || laneNotes.join('; ')}\n`)
    event(t, `iter ${n}: ${ev.verdict} ac ${row.ac} metric ${ev.metric}${ev.why?.length ? ` (${ev.why.join('; ')})` : ''}`)
    if (ev.done) { stopReason = 'target reached: acceptance green, no regression, metric on target'; break }
  }
  return finish(root, key, stopReason)
}

export async function finish(root, key, stopReason) {
  const t = loadTask(root, key)
  const iterations = readJson(art(t, 'iterations.json'), [])
  const done = !!t.best?.eval?.done
  const items = itemState(t)
  const blocked = listFindings(t).filter((f) => f.status === 'blocked')
  const finalState = done ? 'DONE' : stopReason === 'stopped by owner' ? 'STOPPED' : 'ESCALATED'
  t.stop_reason = stopReason
  saveTask(t)
  setState(t, finalState, stopReason)
  const goal = readArt(t, 'goal.json')
  const harvested = learn.harvest(t.slug, { goal, iterations, base: readArt(t, 'baseline.json'), finalEval: t.best?.eval })
  const t2 = loadTask(root, key)
  t2.learned = harvested
  saveTask(t2)
  const reportPath = writeReport(t2, { iterations, items, blocked, findings: listFindings(t2), harvested })
  const delivery = await deliver(t2.report_to, reportPath, `[forge] ${t2.key} ${finalState}`)
  const t3 = loadTask(root, key)
  t3.delivery = delivery
  saveTask(t3)
  event(t3, `report ${reportPath}; delivery ${delivery.map((d) => `${d.target}:${d.ok ? 'ok' : 'FAIL ' + d.detail}`).join(', ') || 'none'}`)
  return { state: finalState, stopReason, report: reportPath, delivery }
}
