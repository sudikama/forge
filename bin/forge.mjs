#!/usr/bin/env node
// forge CLI: the one entry point used by the slash commands, the skill, the hooks and the
// background runner. Every gate is enforced here (deterministic validators), never by prompt text.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PLUGIN_ROOT, HOME_FORGE, parseArgs, die, readJson, writeJson, repoRoot, run, sh, now, option, tail } from '../lib/util.mjs'
import * as T from '../lib/task.mjs'
import { LANES, laneOrder, laneUsable, ask, noul } from '../lib/jev.mjs'
import { triagePrompt, triageWorklist } from '../lib/triage.mjs'
import { addSource } from '../lib/io.mjs'
import { plan as planLanes } from '../lib/lanes.mjs'
import { baseline as runBaseline } from '../lib/judge.mjs'
import * as clarify from '../lib/clarify.mjs'
import * as learn from '../lib/learn.mjs'
import { runLoop, finish, addFinding, listFindings, itemState, FINDING_KINDS } from '../lib/runner.mjs'
import { startSmall } from '../lib/small.mjs'
import { handleHook } from '../lib/hooks.mjs'

const argv = process.argv.slice(2)
const a = parseArgs(argv)
const cmd = a._[0]
const root = repoRoot(a.cwd || process.cwd())
const out = (x) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n')
const readStdin = () => fs.readFileSync(0, 'utf8')

function need(t) { if (!t) die('no active forge task in this repo (forge new ...)'); return t }
function task() { return need(T.loadTask(root, a.task || undefined)) }
function problems(list, label) { return list.map((p) => `[${label}] ${p}`) }

// Recompute the furthest state the artifacts justify (never moves past READY by itself).
function gates(t) {
  const g = { INTAKE: T.checkSources(t) }
  g.SPEC = [...problems(T.checkGoal(t), 'goal'), ...problems(T.checkSpec(t), 'spec')]
  g.SCOPED = problems(T.checkScope(t), 'scope')
  const base = T.readArt(t, 'baseline.json')
  g.PLANNED = [...problems(T.checkWorklist(t), 'worklist'), ...problems(T.checkMatrix(t), 'matrix'),
    ...(T.readArt(t, 'lanes.json') ? [] : ['[lanes] not computed (forge lanes)']),
    ...(base ? [] : ['[baseline] not run (forge baseline)'])]
  g.CLARIFY = problems(T.checkClarify(t), 'clarify')
  return g
}

function advance(t) {
  if (t.mode !== 'large' || T.TERMINAL.includes(t.state) || ['READY', 'RUNNING', 'PAUSED'].includes(t.state)) return { state: t.state, blocking: [] }
  const g = gates(t)
  // state = the first stage whose gate still fails (the one being worked on); all green = CLARIFY done.
  let reached = 'CLARIFY'
  let blocking = []
  for (const s of ['INTAKE', 'SPEC', 'SCOPED', 'PLANNED', 'CLARIFY']) {
    if (g[s].length) { reached = s; blocking = g[s]; break }
  }
  if (reached !== t.state) T.setState(t, reached, 'artifacts validated')
  return { state: reached, blocking, ready_to_lock: !blocking.length && reached === 'CLARIFY' }
}

const NEXT = {
  INTAKE: 'register the sources the task comes from: forge source add (jira | gdoc | pdf | markdown | prd | figma)',
  SPEC: 'write goal.json and spec.md in the task dir (forge template goal|spec), every AC with (source: ...)',
  SCOPED: 'validate the codebase: write scope.json (in_scope / impacted / out_of_scope / conflicts with file:line evidence)',
  PLANNED: 'write worklist.json + matrix.json (happy/unhappy/edge per AC, regression per impacted path), then forge lanes and forge baseline',
  CLARIFY: 'forge clarify, ask the owner every question in ONE AskUserQuestion batch, record with forge answer, then forge lock --approve',
  READY: 'forge run (starts the background loop)',
  RUNNING: 'loop running: forge status / forge pause / forge stop',
}

async function main() {
  switch (cmd) {
    case 'doctor': return doctor()
    case 'triage': {
      const text = a.stdin ? readStdin() : a._.slice(1).join(' ')
      return out(await triagePrompt(text))
    }
    case 'new': {
      const key = a.key || a._[1] || die('forge new <KEY> --mode small|large --title "..." --report-to telegram,jira:KEY,file')
      const mode = a.mode || die('--mode small|large is required')
      if (!['small', 'large'].includes(mode)) die('--mode must be small or large')
      const reportTo = String(a['report-to'] || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (mode === 'large' && !reportTo.length) die('--report-to is required for a large task: ask the owner where the final report goes (telegram[:chat[:thread]], jira:KEY, file)')
      const t = T.createTask(root, { key, mode, title: a.title, reportTo })
      if (mode === 'small') { t.small = null; startSmall(t, { request: a.title || key }); t.small.session_id = a.session || null; T.saveTask(t) }
      return out({ created: key, mode, dir: t.dir, state: t.state, next: mode === 'small' ? 'write the plan: forge plan --stdin' : NEXT.INTAKE })
    }
    case 'use': { T.setActive(root, a._[1] || die('forge use <KEY>')); return out({ active: a._[1] }) }
    case 'list': {
      const d = path.join(T.forgeDir(root), 'tasks')
      const keys = fs.existsSync(d) ? fs.readdirSync(d) : []
      return out(keys.map((k) => { const t = T.loadTask(root, k); return t ? `${k}\t${t.mode}\t${t.state}\t${t.title}` : k }).join('\n') || '(no tasks)')
    }
    case 'source': {
      const t = task()
      if (a._[1] !== 'add') die('forge source add --kind jira|gdoc|pdf|markdown|prd|figma|file (--ref X | --file PATH | --stdin)')
      const e = await addSource(t, { kind: a.kind, ref: a.ref, file: a.file && path.resolve(a.file), stdinText: a.stdin ? readStdin() : null, label: a.label })
      T.saveTask(t); T.event(t, `source ${e.kind} ${e.ref} saved as source/${e.file}`)
      advance(t)
      return out(e)
    }
    case 'template': {
      const name = a._[1] || die('forge template goal|spec|scope|matrix|worklist [--write]')
      const file = { goal: 'goal.json', spec: 'spec.md', scope: 'scope.json', matrix: 'matrix.json', worklist: 'worklist.json' }[name] || die('unknown template')
      const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', file), 'utf8')
      if (a.write) {
        const t = task(); const dst = T.art(t, file)
        if (fs.existsSync(dst) && !a.force) die(`${dst} exists (use --force)`)
        fs.writeFileSync(dst, src); return out({ written: dst })
      }
      return out(src)
    }
    case 'check': {
      const t = task()
      if (t.mode === 'small') return out({ mode: 'small', phase: t.small?.phase, revisions: t.small?.revisions })
      const r = advance(t)
      const t2 = task()
      return out({ key: t2.key, state: t2.state, blocking: r.blocking, ready_to_lock: !!r.ready_to_lock, next: NEXT[t2.state], dir: t2.dir })
    }
    case 'lanes': {
      const t = task()
      const wl = T.readArt(t, 'worklist.json') || die('worklist.json missing')
      const p = T.checkWorklist(t); if (p.length) die(p.join('\n'))
      const quota = laneOrder().includes('commandcode') && !laneUsable('zen').ok ? 2 : 4
      const lp = planLanes(wl, { root: t.root, hardCap: Number(option('maxWorkers', 4)), quotaCap: quota, memPerWorkerMb: Number(option('workerMemMb', 1200)) })
      writeJson(T.art(t, 'lanes.json'), lp)
      const tw = triageWorklist(wl, lp)
      T.event(t, `lanes: recommend ${lp.recommended_workers}; ${lp.rationale}`)
      advance(t)
      return out({ ...lp, triage_pass2: tw })
    }
    case 'baseline': {
      const t = task()
      const goal = T.readArt(t, 'goal.json') || die('goal.json missing')
      const matrix = T.readArt(t, 'matrix.json') || die('matrix.json missing')
      const dirty = run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: t.root }).stdout.trim()
      if (dirty && !a.force) die(`working tree has uncommitted changes; the baseline must run on a commit:\n${dirty}`)
      const head = T.git(['rev-parse', 'HEAD'], t.root)
      const b = runBaseline(t, matrix, goal, t.root)
      b.commit = head
      b.characterization = (matrix.cases || []).filter((c) => c.kind === 'regression' && c.characterization && c.file).map((c) => c.file)
      writeJson(T.art(t, 'baseline.json'), b)
      T.event(t, `baseline at ${head.slice(0, 8)}: metric ${b.metric}, suite ${b.suite.pass ? 'green' : 'RED'}, ${b.issues.length} issue(s), flaky ${b.flaky.length}`)
      advance(t)
      return out({ commit: head, metric: b.metric, suite_green: b.suite.pass, cases: b.cases, flaky: b.flaky, issues: b.issues })
    }
    case 'clarify': {
      const t = task()
      const c = clarify.build(t, { lanePlan: T.readArt(t, 'lanes.json'), base: T.readArt(t, 'baseline.json'), instincts: learn.promptBlock(t.slug) })
      writeJson(T.art(t, 'clarify.json'), c)
      advance(t)
      if (a.json) return out(c)
      const open = c.questions.filter((q) => !q.answer).length
      return out(`${clarify.render(c)}\n\n${open} unanswered. Ask them in ONE AskUserQuestion batch (recommendation first), then record each: forge answer <ID> "<answer>"`)
    }
    case 'answer': {
      const t = task()
      const c = T.readArt(t, 'clarify.json') || die('run forge clarify first')
      const id = a._[1] || die('forge answer <ID> "<answer>"')
      const text = a._.slice(2).join(' ') || (a.stdin ? readStdin().trim() : '')
      if (!text) die('empty answer')
      const q = c.questions.find((x) => x.id === id) || die(`no question ${id}`)
      q.answer = text; q.answered_by = a.by || 'owner'; q.answered_at = now()
      writeJson(T.art(t, 'clarify.json'), c)
      if (id === 'E1' && /^\d+$/.test(text.trim())) { t.workers = Math.min(Number(text.trim()), Number(option('maxWorkers', 4))); T.saveTask(t) }
      if (a.correction) learn.correction(t.slug, a.correction)
      T.event(t, `clarify ${id}: ${text}`)
      fs.appendFileSync(T.art(t, 'decisions.md'), `- ${id} (${q.group}): ${q.question}\n  answer: ${text}\n`)
      advance(t)
      return out({ id, answer: text, open: c.questions.filter((x) => !x.answer).map((x) => x.id) })
    }
    case 'lock': {
      const t = task()
      if (t.mode !== 'large') die('lock is for large tasks')
      const r = advance(t)
      if (!r.ready_to_lock) die(`cannot lock, gates still failing:\n${r.blocking.join('\n')}`)
      if (!a.approve) die('spec lock needs the owner\'s approval: show goal/spec/scope/lanes summary, ask the owner, then run forge lock --approve (Claude Code will ask the owner to confirm this command)')
      const head = T.git(['rev-parse', 'HEAD'], t.root)
      const base = T.readArt(t, 'baseline.json')
      if (base.commit !== head) die(`baseline ran at ${String(base.commit).slice(0, 8)} but HEAD is ${head.slice(0, 8)}: re-run forge baseline`)
      const dirty = run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: t.root }).stdout.trim()
      if (dirty) die(`working tree not clean:\n${dirty}`)
      const blockers = (base.issues || []).filter((i) => {
        const q = (T.readArt(t, 'clarify.json').questions || []).find((x) => x.id === `D-${i.id}`)
        return !q || !/known_red|exclude/i.test(q.answer || '')
      })
      if (blockers.length && !a['accept-baseline-issues']) die(`baseline issues not resolved (fix them or answer "mark known_red"):\n${blockers.map((b) => `${b.id}: ${b.issue}`).join('\n')}`)
      t.lock = { at: now(), commit: head, approved_by: a.by || 'owner', hashes: {} }
      t.lock.hashes = T.computeLock(t)
      t.workers = t.workers || T.readArt(t, 'lanes.json').recommended_workers
      T.saveTask(t)
      T.setState(t, 'READY', `spec locked at ${head.slice(0, 8)}, ${Object.keys(t.lock.hashes).length} files hashed, workers ${t.workers}`)
      return out({ locked: true, commit: head, files: Object.keys(t.lock.hashes), workers: t.workers, next: NEXT.READY })
    }
    case 'run': {
      const t = task()
      if (!['READY', 'PAUSED', 'RUNNING'].includes(t.state)) die(`task is ${t.state}; it must be READY (forge lock --approve)`)
      const bad = T.verifyLock(t).filter((f) => !f.startsWith('.forge/'))
      if (bad.length) die(`locked files changed since lock: ${bad.join(', ')}`)
      if (a.foreground) {
        const r = await runLoop(root, t.key)
        return out(r)
      }
      const log = T.art(t, 'runner.log')
      const fd = fs.openSync(log, 'a')
      const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'forge.mjs'), 'run', '--foreground', '--task', t.key, '--cwd', root], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: process.env })
      child.unref()
      t.runner_pid = child.pid; T.saveTask(t)
      T.event(t, `runner started pid ${child.pid}`)
      return out({ started: true, pid: child.pid, log, watch: 'forge status' })
    }
    case 'pause': case 'stop': case 'resume': {
      const t = task()
      fs.writeFileSync(T.art(t, 'control'), (cmd === 'resume' ? 'run' : cmd) + '\n')
      T.event(t, `control ${cmd}`)
      return out({ control: cmd, note: cmd === 'resume' ? 'run forge run again to restart the runner' : 'takes effect at the next iteration boundary' })
    }
    case 'status': {
      const t = task()
      if (t.mode === 'small') return out({ key: t.key, mode: 'small', phase: t.small?.phase, revisions: `${t.small?.revisions}/${t.small?.max_revisions}`, last_test: T.readArt(t, 'test-last.json')?.green })
      const it = T.readArt(t, 'iterations.json') || []
      const alive = t.runner_pid ? run(['kill', '-0', String(t.runner_pid)]).code === 0 : false
      return out({
        key: t.key, state: t.state, runner: t.runner_pid ? `${t.runner_pid} ${alive ? 'alive' : 'not running'}` : 'never started',
        iteration: t.iteration, best: t.best ? { commit: t.best.commit?.slice(0, 8), metric: t.best.metric, ac: t.best.ac_pass } : null,
        plateau: t.plateau, items: itemState(t).map((i) => `${i.id}:${i.status}`),
        findings: listFindings(t).map((f) => `${f.id}:${f.kind}:${f.status}`),
        last: it.slice(-3).map((r) => `${r.iter} ${r.verdict} ac ${r.ac} metric ${r.metric} ${r.why?.join('; ') || ''}`),
        stop_reason: t.stop_reason || null, report: fs.existsSync(T.art(t, 'report.md')) ? T.art(t, 'report.md') : null,
      })
    }
    case 'finding': {
      // Used by lanes. --task-dir points at the task (lanes run in a worktree, not the repo root).
      const dir = a['task-dir'] || process.env.FORGE_TASK_DIR || (T.loadTask(root) || {}).dir || die('--task-dir needed')
      const f = addFinding(dir, {
        kind: a.kind, title: a.title, evidence: a.evidence, item: a.item, lane: a.lane || process.env.FORGE_LANE || null,
        iter: Number(process.env.FORGE_ITER || 0) || null, options: a.options ? String(a.options).split('|').map((s) => s.trim()) : [],
      })
      return out({ filed: f.id, note: 'the orchestrator decides it after this iteration; continue with the rest of your items' })
    }
    case 'findings': return out(listFindings(task()))
    case 'report': {
      const t = task()
      if (a.regenerate || !fs.existsSync(T.art(t, 'report.md'))) {
        const r = await finish(root, t.key, t.stop_reason || 'report requested manually')
        return out(r)
      }
      return out(fs.readFileSync(T.art(t, 'report.md'), 'utf8'))
    }
    // ---------- small harness ----------
    case 'plan': {
      const t = task()
      const p = JSON.parse(a.stdin ? readStdin() : fs.readFileSync(a.file, 'utf8'))
      writeJson(T.art(t, 'plan.json'), p)
      const wl = { items: (p.items || [{ id: 'W1', size: (p.files || []).length > 5 ? 'L' : 'S', writes: p.files || [] }]) }
      const tw = triageWorklist(wl, null)
      T.event(t, `plan: ${(p.files || []).length} files, ${(p.cases || []).length} cases${tw.large ? `; pass-2 triage says LARGE (${tw.reasons.join(', ')})` : ''}`)
      return out({ saved: T.art(t, 'plan.json'), escalate: tw.large ? `pass-2 triage: ${tw.reasons.join(', ')}. Tell the owner and propose switching to a large task (forge new <KEY> --mode large); never downgrade the other way.` : null })
    }
    case 'phase': {
      const t = task()
      const ph = a._[1] || die('forge phase PLAN|CLARIFY|BUILD|TEST')
      if (!['PLAN', 'CLARIFY', 'BUILD', 'TEST'].includes(ph)) die('bad phase')
      if (['BUILD', 'TEST'].includes(ph)) {
        const { smallGate } = await import('../lib/small.mjs')
        const g = smallGate(t); if (g.length) die(`plan incomplete:\n${g.join('\n')}`)
      }
      t.small.phase = ph; T.saveTask(t); T.event(t, `small phase ${ph}`)
      return out({ phase: ph })
    }
    // ---------- learning ----------
    case 'learn': {
      const slug = a.repo || T.loadTask(root)?.slug || (await import('../lib/util.mjs')).repoSlug(root)
      const sub = a._[1] || 'list'
      if (sub === 'list') return out(learn.list(slug).map((i) => `[${Number(i.confidence).toFixed(2)}] ${i.id} (${i._origin}) ${i.trigger}: ${i.action}`).join('\n') || '(none)')
      if (sub === 'correct') return out(learn.correction(slug, a._.slice(2).join(' ') || die('forge learn correct "<what to do instead>"')))
      if (sub === 'contradict') return out(learn.mutate(slug, a._[2], -0.2, a.why || 'contradicted by owner') || die('no such instinct'))
      return die('forge learn list|correct|contradict <id>')
    }
    case 'hook': return handleHook(a._[1])
    case 'jev': {
      const r = await ask({ text: a._.slice(1).join(' ') }, { q: noul(a.q || 'Is this text a request to change software?') }, { purpose: 'cli' })
      return out(r)
    }
    default:
      return out(`forge: engineering loop for Claude Code
  doctor                         check Claude Code, Jev lanes, MCP servers, tools
  triage "<request>"             size + clarity triage (Jev prior + cues)
  new <KEY> --mode small|large --title ".." --report-to telegram:CHAT:THREAD,jira:KEY,file
  source add --kind jira|gdoc|pdf|markdown|prd|figma|file (--ref|--file|--stdin)
  template goal|spec|scope|matrix|worklist [--write]
  check                          validate artifacts, advance state, print next step
  lanes                          worker recommendation from worklist (no file collisions)
  baseline                       run matrix + suite + metric at HEAD (twice, for flaky)
  clarify | answer <ID> "<a>"   numbered decisions for the owner
  lock --approve                 spec lock (owner approval) | run | status | pause | stop | resume
  finding --kind K --title T --evidence E [--item W1]   (lanes report to the orchestrator)
  report [--regenerate] | learn list|correct|contradict
  plan --stdin | phase P         small-task harness`)
  }
}

async function doctor() {
  const rows = []
  const ok = (name, good, detail) => rows.push(`${good ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  const v = run(['claude', '--version'])
  const ver = (v.stdout.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number)
  ok('claude code', v.code === 0 && (ver[0] > 2 || (ver[0] === 2 && (ver[1] > 1 || ver[2] >= 280))), v.stdout.trim() || v.stderr.trim())
  const auth = run(['claude', 'auth', 'status'])
  let logged = false; try { logged = JSON.parse(auth.stdout).loggedIn } catch {}
  ok('claude auth (needed by loop agents)', logged || !!process.env.ANTHROPIC_API_KEY, logged ? 'logged in' : process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY set' : 'not logged in: run `claude` once and /login, or set ANTHROPIC_API_KEY')
  ok('node', true, process.version)
  ok('git', run(['git', '--version']).code === 0)
  for (const name of Object.keys(LANES).filter((n) => n !== 'mock')) {
    const u = laneUsable(name)
    if (!u.ok) { ok(`jev lane ${name}`, false, u.why); continue }
    if (a.offline) { ok(`jev lane ${name}`, true, 'configured (not probed)'); continue }
    const saved = process.env.FORGE_JEV_LANES
    process.env.FORGE_JEV_LANES = name
    const t0 = Date.now()
    const r = await ask({ text: 'fix a typo in README.md' }, { q: noul('Is this a request to change software?') }, { purpose: 'doctor', timeoutMs: 15000 })
    if (saved === undefined) delete process.env.FORGE_JEV_LANES; else process.env.FORGE_JEV_LANES = saved
    ok(`jev lane ${name}`, !!r.answers?.q, r.answers?.q ? `noul ${r.answers.q.noul.toFixed(2)} in ${Date.now() - t0}ms` : r.tried.join('; '))
  }
  ok('jev lane order', true, laneOrder().join(' then '))
  const mcp = run(['claude', 'mcp', 'list'], { timeoutSec: 60 })
  const list = mcp.stdout + mcp.stderr
  for (const [name, re, why] of [['jira mcp', /jira/i, 'Jira tickets as source; fallback JIRA_BASE_URL/JIRA_EMAIL/JIRA_TOKEN in ~/.forge/env'], ['google drive mcp', /drive|gdrive|google/i, 'Google Docs as source (OAuth by the owner)'], ['figma mcp', /figma/i, 'Figma frames as source'], ['codebase-memory mcp', /codebase/i, 'impact analysis for scope.json (grep works without it)']]) {
    ok(name, re.test(list), re.test(list) ? 'registered' : `not registered: ${why}`)
  }
  const pdf = run(['python3', '-c', 'import fitz']).code === 0 || run(['pdftotext', '-v']).code === 0
  ok('pdf extractor', pdf, pdf ? '' : 'none (pdftotext / pymupdf); the Read tool still reads PDFs in-session')
  ok('hermes send (telegram reports)', run(['hermes', 'send', '--help']).code === 0)
  const shim = path.join(process.env.HOME, '.local', 'bin', 'forge')
  if (a['install-shim']) { fs.mkdirSync(path.dirname(shim), { recursive: true }); fs.writeFileSync(shim, `#!/bin/sh\nexec node "${path.join(PLUGIN_ROOT, 'bin', 'forge.mjs')}" "$@"\n`, { mode: 0o755 }) }
  ok('forge on PATH', fs.existsSync(shim), fs.existsSync(shim) ? shim : 'forge doctor --install-shim')
  ok('function hooks flag', process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1', 'only needed for per-turn effort routing (optional)')
  out(rows.join('\n'))
}

main().catch((e) => die(e.stack || e.message))
