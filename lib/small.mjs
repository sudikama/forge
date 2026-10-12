// Small-task harness: PLAN, CLARIFY, BUILD, TEST, JUDGE, REVISE (max N), DONE, inside one
// Claude Code session. The Stop hook is the driver: while the task is open it refuses to
// let the turn end, re-prompting with the judge's verdict, until the gate is green or the
// revision cap is hit (then it escalates to the user instead of looping).
import { saveTask, event, readArt, art } from './task.mjs'
import { sh, tail, writeJson, option, sha256 } from './util.mjs'
import { classifyFailure, firstErrorLine } from './judge.mjs'
import * as learn from './learn.mjs'
import { workspaceFingerprint, record } from './guard.mjs'


export const PHASES = ['PLAN', 'CLARIFY', 'BUILD', 'TEST', 'DONE', 'ESCALATED']

export function startSmall(t, { request }) {
  t.small = { phase: 'PLAN', request, revisions: 0, max_revisions: Number(option('smallMaxRevisions', 3)), stop_blocks: 0 }
  saveTask(t)
  event(t, 'small harness started at PLAN')
}

export function smallGate(t) {
  const plan = readArt(t, 'plan.json')
  const p = []
  if (!plan) return ['plan.json missing: run `forge plan --stdin` with {steps, files, test_cmd, cases}']
  if (!plan.test_cmd) p.push('plan.test_cmd empty')
  const kinds = new Set((plan.cases || []).map((c) => c.kind))
  for (const k of ['happy', 'unhappy', 'edge']) if (!kinds.has(k)) p.push(`plan.cases has no ${k} case`)
  if (!(plan.files || []).length) p.push('plan.files empty')
  return p
}

export function runTests(t) {
  const plan = readArt(t, 'plan.json')
  const results = []
  for (const c of plan.cases || []) {
    if (!c.cmd) continue
    const r = sh(c.cmd, { cwd: t.root, timeoutSec: c.timeout_sec || 600 })
    results.push({ id: c.id, kind: c.kind, pass: r.code === (c.expect_exit ?? 0), out: tail(r.stdout + r.stderr, 25) })
  }
  const suite = sh(plan.test_cmd, { cwd: t.root, timeoutSec: plan.timeout_sec || 1800 })
  const reg = plan.regression_cmd ? sh(plan.regression_cmd, { cwd: t.root, timeoutSec: 1800 }) : null
  const green = suite.code === 0 && results.every((r) => r.pass) && (!reg || reg.code === 0)
  const out = { at: new Date().toISOString(), green, suite_code: suite.code, suite_out: tail(suite.stdout + suite.stderr, 40), regression_code: reg?.code ?? null, cases: results }
  writeJson(art(t, 'test-last.json'), out)
  return out
}

// What the Stop hook says. Returns null when the turn may end.
export async function onStop(t, { stopHookActive }) {
  const s = t.small
  if (!s || ['DONE', 'ESCALATED'].includes(s.phase)) return null
  const cap = Number(option('stopBlockCap', 12))
  if (s.stop_blocks >= cap) {
    s.phase = 'ESCALATED'; saveTask(t); event(t, `stop-block cap ${cap} hit`)
    return null
  }
  s.stop_blocks += 1
  let msg
  if (s.phase === 'PLAN') {
    const gaps = smallGate(t)
    msg = gaps.length
      ? `forge PLAN is not complete:\n- ${gaps.join('\n- ')}\nWrite the plan as JSON and pipe it to \`forge plan --stdin\` (steps, files, test_cmd, regression_cmd, cases with kind happy|unhappy|edge and a cmd each). Then ask the user any open decision (AskUserQuestion) and run \`forge phase BUILD\`.`
      : 'forge plan is valid. Ask the user the open decisions now (AskUserQuestion, one batch, with your recommendation), record them with `forge answer`, then run `forge phase BUILD` and implement.'
  } else if (s.phase === 'CLARIFY') {
    msg = 'forge is waiting for clarify answers. Ask them with AskUserQuestion, then `forge phase BUILD`.'
  } else {
    // T (thrash): the workspace is byte-identical to the last red run, so the same tests would
    // give the same answer. Do not re-run them or spend a revision; after two such turns escalate.
    const fp = workspaceFingerprint(t.root)
    if (fp && s.last_red_fp === fp) {
      s.thrash = (s.thrash || 0) + 1
      record({ rule: 'TASK_THRASH', family: 'T', decision: s.thrash >= 2 ? 'escalate' : 'deny', where: 'small', key: t.key, target: `unchanged since revision ${s.revisions}` })
      if (s.thrash >= 2) {
        s.phase = 'ESCALATED'; saveTask(t); event(t, 'small: thrash, two turns ended without changing the workspace')
        return { block: false, context: `forge: the workspace has not changed since the last red run, twice. Stop and report to the owner what blocks you (the failing cases and what you tried). Do not re-run the same checks.` }
      }
      saveTask(t)
      return { block: true, reason: `forge: nothing changed since the last red run (same files, same content), so the tests were not re-run and no revision was spent. Change the code to fix the failing cases, or say plainly what blocks you. Repeating the same check does not add evidence.` }
    }
    const r = runTests(t)
    if (r.green) {
      s.phase = 'DONE'; saveTask(t)
      event(t, `small: green after ${s.revisions} revision(s)`)
      const plan = readArt(t, 'plan.json')
      if (plan?.test_cmd) learn.capture(t.slug, { id: `test-cmd-${sha256(plan.test_cmd).slice(0, 8)}`, trigger: `when running tests in ${t.slug}`, action: `use: ${plan.test_cmd}`, domain: 'testing', source: 'session-observation', evidence: 'small task suite green' })
      return { block: false, context: `forge: tests green (${r.cases.length} case(s) + suite). Task ${t.key} is DONE. Summarise what changed and the evidence.` }
    }
    s.revisions += 1
    s.last_red_fp = workspaceFingerprint(t.root) // after the run: artifacts the tests write are part of "unchanged"
    s.thrash = 0
    if (s.revisions > s.max_revisions) {
      s.phase = 'ESCALATED'; saveTask(t)
      event(t, `small: revision cap ${s.max_revisions} exceeded`)
      return { block: false, context: `forge: still red after ${s.max_revisions} revisions. Stop and report to the user: failing cases, the first error of each, and what you think the cause is. Do not keep trying.` }
    }
    const fc = await classifyFailure({ failing: r.cases.filter((c) => !c.pass), suite_green: r.suite_code === 0, suite_out: r.suite_out })
    const failing = r.cases.filter((c) => !c.pass).map((c) => `- ${c.id} (${c.kind}): ${firstErrorLine(c.out)}`).join('\n') || `- suite exit ${r.suite_code}: ${firstErrorLine(r.suite_out)}`
    saveTask(t)
    msg = `forge TEST is red (revision ${s.revisions}/${s.max_revisions}). Likely cause: ${fc?.cls || 'unknown'}.\n${failing}\nFix the cause, do not weaken or delete tests, then end your turn again so forge re-runs the gate.`
  }
  return { block: true, reason: msg }
}
