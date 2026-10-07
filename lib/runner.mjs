// Large-task loop: orchestrator + lanes (subagents in their own git worktrees) + an
// independent deterministic judge, ratcheting one integration branch like autoresearch:
// an iteration is kept only when it is green, regression-free and better; otherwise reset.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PLUGIN_ROOT, readJson, writeJson, run, git, now, sha256File, matchAny, option, tail } from './util.mjs'
import { loadTask, saveTask, setState, event, readArt, art, TERMINAL } from './task.mjs'
import { evaluate, classifyFailure, firstErrorLine, writeIterLog, better } from './judge.mjs'
import { ask, choice } from './jev.mjs'
import * as learn from './learn.mjs'
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

function agentArgv(promptFile, { maxTurns }) {
  return ['claude', '-p', '--plugin-dir', PLUGIN_ROOT, '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,MultiEdit,Glob,Grep,Bash', '--max-turns', String(maxTurns), '--output-format', 'json']
}

function runAgent({ t, role, lane, tag, cwd, prompt, iter, timeoutMin, maxTurns }) {
  const dir = path.join(t.dir, 'agents')
  fs.mkdirSync(dir, { recursive: true })
  const stem = `${String(iter).padStart(4, '0')}-${role}${lane ? '-' + lane : ''}${tag ? '-' + tag : ''}`
  const promptFile = path.join(dir, `${stem}.prompt.md`)
  const logFile = path.join(dir, `${stem}.log`)
  fs.writeFileSync(promptFile, prompt)
  const env = { ...process.env, FORGE_ROLE: role, FORGE_LANE: lane || '', FORGE_TASK_DIR: t.dir, FORGE_WORKTREE: cwd, FORGE_PROMPT_FILE: promptFile, FORGE_ITER: String(iter) }
  const custom = process.env.FORGE_AGENT_CMD || option('agentCmd', '')
  const argv = custom ? ['bash', '-lc', custom] : agentArgv(promptFile, { maxTurns })
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w')
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: [custom ? 'ignore' : fs.openSync(promptFile, 'r'), out, out], detached: true })
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, timeoutMin * 60 * 1000)
    child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ role, lane, code: code ?? (signal ? 124 : 1), log: logFile }) })
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
      const r = await runAgent({ t, role: 'orchestrator', tag: f.id, cwd: integDir, prompt, iter, timeoutMin: budget.lane_timeout_min || 30, maxTurns: 40 })
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

    const jobs = activeLanes.map((l) => {
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
      return runAgent({ t, role: 'lane', lane: l.lane, cwd: dir, prompt, iter: n, timeoutMin: budget.lane_timeout_min, maxTurns: budget.lane_max_turns }).then((r) => ({ ...r, dir, owns: l.owns, items: l.todo.map((i) => i.id) }))
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

    const row = { iter: n, at: now(), head_before: head, verdict: ev.verdict, why: ev.why, ac: `${ev.ac_pass}/${ev.ac_total}`, metric: ev.metric, regressions: ev.regressions, lanes: laneNotes, findings: decided.map((f) => `${f.id}:${f.status}`), failure_class: ev.failure_class?.cls || null, first_error: ev.failing?.[0] ? firstErrorLine(ev.failing[0].out) : null, caught }
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
    fs.appendFileSync(art(t, 'results.tsv'), (fs.existsSync(art(t, 'results.tsv')) ? '' : 'iter\tcommit\tmetric\tac\tstatus\tdescription\n') + `${n}\t${(row.commit || '').slice(0, 7)}\t${ev.metric ?? ''}\t${row.ac}\t${ev.verdict}\t${(ev.why || []).join('; ').replace(/\t/g, ' ') || laneNotes.join('; ')}\n`)
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
