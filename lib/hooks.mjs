// Classic Claude Code hooks (command hooks in hooks/hooks.json, so the plugin works without the
// early-access function-hook flag). Each handler reads the hook JSON on stdin and answers on stdout.
//   UserPromptSubmit: size + clarity triage, routes the request to the small harness or the big loop
//   PreToolUse:       deterministic gate (locked files, lane ownership, irreversible commands)
//   Stop:             drives the small harness (block + reason until the tests are green)
//   SessionStart:     tells the session which forge task is active
import fs from 'node:fs'
import path from 'node:path'
import { readJson, repoRoot, matchAny, option, appendJsonl, HOME_FORGE, now } from './util.mjs'
import * as T from './task.mjs'
import { triagePrompt } from './triage.mjs'
import { onStop } from './small.mjs'
import * as learn from './learn.mjs'

function input() { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} } }
function emit(o) { process.stdout.write(JSON.stringify(o)); process.exit(0) }
function log(row) { try { appendJsonl(path.join(HOME_FORGE, 'logs', 'hooks.jsonl'), { at: now(), ...row }) } catch {} }

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
// Irreversible or outside-the-loop commands; denied always inside lanes, during a running loop in the session.
const DENY_ALWAYS = [
  [/\bgit\s+push\b[^\n]*(--force|-f\b|--mirror|--delete)/, 'force/mirror/delete push'],
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/, 'recursive delete of / or home'],
  [/\b(drop\s+(database|schema)|truncate\s+table)\b/i, 'destructive SQL'],
  [/\bmkfs\.|\bdd\s+if=.*\bof=\/dev\//, 'disk write'],
]
const DENY_IN_LANE = [
  [/\bgit\s+(push|commit|merge|rebase|reset|checkout|switch|cherry-pick|stash|worktree|branch\s+-[dD])\b/, 'lanes never touch git history: forge commits and the judge decides'],
  [/\bgit\s+push\b/, 'push is the owner\'s decision'],
]

function laneInfo(cwd) {
  let dir = cwd
  for (let i = 0; i < 8 && dir && dir !== '/'; i++) {
    const p = path.join(dir, '.forge-lane')
    if (fs.existsSync(p)) return { ...readJson(p, {}), root: dir }
    dir = path.dirname(dir)
  }
  return null
}

function relTo(root, file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file)
  const r = path.relative(root, abs)
  return r.startsWith('..') ? null : r
}

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `forge: ${reason}` } })
}

export function gate(e) {
  const cwd = e.cwd || process.cwd()
  const tool = e.tool_name
  const ti = e.tool_input || {}
  const lane = laneInfo(cwd)
  if (lane) {
    // Inside a loop lane: ownership + locks, both enforced before the write happens.
    if (WRITE_TOOLS.includes(tool)) {
      const rel = relTo(lane.root, ti.file_path || ti.notebook_path || '')
      if (rel === null) deny(`lane ${lane.lane} may only write inside its worktree`)
      if (rel === '.forge-lane') deny('the lane marker is forge\'s')
      if (matchAny(rel, lane.locked || [])) deny(`${rel} is locked (evaluator/tests/baseline); report a finding if it is wrong`)
      if (lane.role === 'lane' && !matchAny(rel, lane.owns || [])) deny(`${rel} is outside lane ${lane.lane}'s files (${(lane.owns || []).join(', ')}). File a finding: forge finding --kind shared_file_change ...`)
      if (lane.role === 'orchestrator' && !matchAny(rel, lane.owns || [])) deny(`${rel} is not an orchestrator-owned shared file`)
    }
    if (tool === 'Bash') {
      const c = String(ti.command || '')
      for (const [re, why] of [...DENY_ALWAYS, ...DENY_IN_LANE]) if (re.test(c)) deny(why)
    }
    return emit({})
  }
  // Interactive session: protect the active task's locked files and refuse irreversible commands.
  const root = repoRoot(cwd)
  const t = T.loadTask(root)
  if (WRITE_TOOLS.includes(tool) && t) {
    const rel = relTo(root, ti.file_path || ti.notebook_path || '')
    if (rel && t.lock && T.isProtected(t, rel)) deny(`${rel} is locked by task ${t.key} (spec lock at ${t.lock.commit.slice(0, 8)})`)
    if (rel && t.mode === 'small' && t.small?.locked_tests && matchAny(rel, t.small.locked_tests)) deny(`${rel} is a locked test of task ${t.key}: fix the code, not the test`)
  }
  if (tool === 'Bash') {
    const c = String(ti.command || '')
    for (const [re, why] of DENY_ALWAYS) if (re.test(c)) deny(why)
    if (t && t.state === 'RUNNING' && /\bgit\s+(push|reset\s+--hard|checkout|switch)\b/.test(c)) deny(`task ${t.key} is running a loop on ${t.loop_branch}: git push / reset / checkout wait until it stops`)
  }
  return emit({})
}

async function promptSubmit(e) {
  const text = String(e.prompt || '')
  const root = repoRoot(e.cwd || process.cwd())
  if (!text.trim() || text.trim().startsWith('/') || process.env.FORGE_ROLE) return emit({})
  if (option('autoTriage', 'true') === 'false') return emit({})
  const t = T.loadTask(root)
  if (t && !T.TERMINAL.includes(t.state) && !(t.mode === 'small' && ['DONE', 'ESCALATED'].includes(t.small?.phase))) {
    return emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[forge] active task ${t.key} (${t.mode}, ${t.mode === 'small' ? t.small?.phase : t.state}). Run \`forge check\` for the next step.` } })
  }
  if (text.length < Number(option('triageMinChars', 40))) return emit({})
  const r = await triagePrompt(text)
  log({ hook: 'UserPromptSubmit', lane: r.lane, size: r.size, conf: r.confidence, vague: r.vague, jev: r.jev_lane })
  if (r.lane === 'none' || r.lane === 'unknown') return emit({})
  const instincts = learn.promptBlock(T.loadTask(root)?.slug || (await import('./util.mjs')).repoSlug(root))
  const why = `size=${r.size ?? '?'} conf=${r.confidence?.toFixed?.(2) ?? '?'} verifier=${r.signals.has_verifier?.toFixed?.(2) ?? '?'} parallel=${r.signals.parallelizable?.toFixed?.(2) ?? '?'}${r.cues.ticket ? ` ticket=${r.cues.ticket}` : ''}`
  const msg = {
    clarify: `[forge triage: ${why}] This request is too vague to build or loop on (no checkable success criterion). Before any code: ask the owner, in ONE AskUserQuestion batch, what "done" means (observable behaviour, a test or a metric) and which part of the codebase it concerns. Then re-triage.`,
    small: `[forge triage: ${why}] SMALL task. Follow the forge small harness (skill forge:forge-small): forge new <KEY> --mode small --title "..."; write the plan (files, test_cmd, happy+unhappy+edge cases) with forge plan --stdin; ask open decisions up front; build; end the turn so forge runs the tests. If the plan grows past a few files or modules, forge plan will say so: propose a large task instead.`,
    large: `[forge triage: ${why}] LARGE task. Do NOT start coding. Follow the forge big-loop flow (skill forge:forge-large): ask where the final report goes, create the task (forge new <KEY> --mode large --report-to ...), collect the sources (Jira / Google Doc / PDF / markdown / PRD / Figma), write goal + spec, validate the codebase (scope), worklist + test matrix, lanes, baseline, clarify, spec lock, then forge run.`,
  }[r.lane]
  return emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg + (instincts ? `\n${instincts}` : '') } })
}

async function stop(e) {
  if (process.env.FORGE_ROLE) return emit({})
  const root = repoRoot(e.cwd || process.cwd())
  const t = T.loadTask(root)
  if (!t || t.mode !== 'small' || !t.small) return emit({})
  // Bind the small task to the session that runs it; other sessions in the same repo are left alone.
  if (!t.small.session_id) { t.small.session_id = e.session_id; T.saveTask(t) }
  else if (e.session_id && t.small.session_id !== e.session_id) return emit({})
  const r = await onStop(t, { stopHookActive: !!e.stop_hook_active })
  log({ hook: 'Stop', key: t.key, phase: T.loadTask(root)?.small?.phase, block: r?.block ?? false })
  if (!r) return emit({})
  if (r.block) return emit({ decision: 'block', reason: r.reason })
  return emit({ decision: 'block', reason: r.context })
}

function sessionStart(e) {
  const root = repoRoot(e.cwd || process.cwd())
  const t = T.loadTask(root)
  if (!t || T.TERMINAL.includes(t.state)) return emit({})
  return emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[forge] active task ${t.key} (${t.mode}, state ${t.state}${t.mode === 'small' ? `, phase ${t.small?.phase}` : ''}). \`forge status\` / \`forge check\`.` } })
}

export async function handleHook(name) {
  const e = input()
  try {
    if (name === 'pretooluse') return gate(e)
    if (name === 'prompt') return await promptSubmit(e)
    if (name === 'stop') return await stop(e)
    if (name === 'session') return sessionStart(e)
  } catch (err) {
    // Fail open: a forge bug must never wedge the session.
    log({ hook: name, error: String(err?.stack || err) })
    return emit({})
  }
  return emit({})
}
