// Deterministic judge: runs the locked test matrix, the full suite and the metric,
// compares against the baseline, and decides keep/discard. Jev only labels WHY a
// run failed (to steer the next revision); it never decides pass/fail.
import fs from 'node:fs'
import path from 'node:path'
import { sh, tail, now } from './util.mjs'
import { ask, choice } from './jev.mjs'

export function runCase(c, cwd, timeoutSec = 600) {
  const t0 = Date.now()
  const r = sh(c.cmd, { cwd, timeoutSec: c.timeout_sec || timeoutSec, env: { CI: '1', FORGE_CASE: c.id } })
  const want = c.expect_exit ?? 0
  return { id: c.id, kind: c.kind, source: c.source, pass: r.code === want, code: r.code, ms: Date.now() - t0, out: tail(r.stdout + '\n' + r.stderr, 40) }
}

export function runMatrix(matrix, cwd) {
  return (matrix.cases || []).filter((c) => c.cmd).map((c) => runCase(c, cwd))
}

export function runMetric(goal, cwd) {
  const r = sh(goal.metric.cmd, { cwd, timeoutSec: goal.metric.timeout_sec || 900 })
  const text = r.stdout + '\n' + r.stderr
  let value = null
  if (goal.metric.regex) {
    const m = text.match(new RegExp(goal.metric.regex, 'm'))
    if (m) value = Number(m[1])
  } else {
    const nums = r.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite)
    if (nums.length) value = nums[nums.length - 1]
  }
  return { value: Number.isFinite(value) ? value : null, code: r.code, out: tail(text, 20) }
}

export function better(goal, a, b) {
  if (a === null) return false
  if (b === null || b === undefined) return true
  const eps = Number(goal.metric.min_delta ?? 0)
  return goal.metric.direction === 'min' ? a < b - eps : a > b + eps
}

export function meetsTarget(goal, v) {
  if (v === null) return false
  return goal.metric.direction === 'min' ? v <= goal.metric.target : v >= goal.metric.target
}

// Baseline at the base commit: which cases pass already. Regression cases MUST pass here,
// new-behaviour cases are expected red (a green one means the feature exists or the test is vacuous).
export function baseline(t, matrix, goal, cwd) {
  const results = runMatrix(matrix, cwd)
  const suite = sh(goal.test_cmd, { cwd, timeoutSec: goal.test_timeout_sec || 1800 })
  const flaky = []
  // Re-run once to find flaky cases (a case that flips between two runs at the same commit).
  const second = runMatrix(matrix, cwd)
  for (const r of results) {
    const s = second.find((x) => x.id === r.id)
    if (s && s.pass !== r.pass) flaky.push(r.id)
  }
  const metric = runMetric(goal, cwd)
  const regSuite = goal.regression_cmd ? sh(goal.regression_cmd, { cwd, timeoutSec: goal.test_timeout_sec || 1800 }).code === 0 : null
  const issues = []
  if (regSuite === false) issues.push({ id: 'regression_cmd', issue: 'pre-existing suite is red at baseline: fix first or narrow regression_cmd' })
  for (const r of results) {
    if (r.kind === 'regression' && !r.pass && !flaky.includes(r.id)) issues.push({ id: r.id, issue: 'regression case red at baseline (pre-existing failure): fix first, or mark known_red in clarify' })
    if (r.kind !== 'regression' && r.pass && !flaky.includes(r.id)) issues.push({ id: r.id, issue: 'new-behaviour case already green at baseline: feature exists or the test is vacuous' })
  }
  return {
    at: now(), commit: t.base_commit,
    cases: Object.fromEntries(results.map((r) => [r.id, { pass: r.pass, code: r.code }])),
    suite: { pass: suite.code === 0, code: suite.code, out: tail(suite.stdout + suite.stderr, 30) },
    metric: metric.value, metric_out: metric.out, flaky, issues, regression_suite_pass: regSuite,
  }
}

export function evaluate({ goal, matrix, base, best, cwd, knownRed = [] }) {
  const results = runMatrix(matrix, cwd)
  const regressions = results.filter((r) => base.cases[r.id]?.pass && !r.pass && !(base.flaky || []).includes(r.id)).map((r) => r.id)
  const acCases = results.filter((r) => r.kind !== 'regression')
  const acPass = acCases.filter((r) => r.pass).length
  const suite = sh(goal.test_cmd, { cwd, timeoutSec: goal.test_timeout_sec || 1800, env: { CI: '1' } })
  const suiteGreen = suite.code === 0
  const metric = runMetric(goal, cwd)
  // Before the first kept iteration the reference point is the baseline, never "nothing".
  const baseAc = Object.entries(base.cases || {}).filter(([id, c]) => c.pass && results.find((r) => r.id === id && r.kind !== 'regression')).length
  const bestAc = best?.ac_pass ?? baseAc
  const refMetric = best ? best.metric : (base.metric ?? null)
  const progress = acPass > bestAc || (acPass === bestAc && better(goal, metric.value, refMetric))
  let verdict = 'keep'
  const why = []
  if (regressions.length) { verdict = 'discard'; why.push(`regression: ${regressions.join(', ')}`) }
  if (acPass < bestAc) { verdict = 'discard'; why.push(`acceptance went down from ${bestAc} to ${acPass}`) }
  // Suite red is allowed only while the red part is the new-behaviour cases still being built.
  const suiteRedBlocks = !suiteGreen && acPass === acCases.length
  if (suiteRedBlocks) { verdict = 'discard'; why.push('full test suite red although every acceptance case passes') }
  // regression_cmd = the pre-existing suite (new tests excluded); it must stay green on every iteration.
  let regressionSuite = null
  if (goal.regression_cmd) {
    const rr = sh(goal.regression_cmd, { cwd, timeoutSec: goal.test_timeout_sec || 1800, env: { CI: '1' } })
    regressionSuite = { pass: rr.code === 0, out: tail(rr.stdout + '\n' + rr.stderr, 40) }
    if (!regressionSuite.pass && base.regression_suite_pass !== false) { verdict = 'discard'; why.push('pre-existing suite (regression_cmd) went red') }
  }
  if (verdict === 'keep' && !progress) { verdict = 'discard'; why.push('no progress: acceptance count and metric did not improve') }
  const done = verdict === 'keep' && acPass === acCases.length && suiteGreen && meetsTarget(goal, metric.value) && regressions.length === 0
  return {
    verdict, why, done, ac_pass: acPass, ac_total: acCases.length, regressions, suite_green: suiteGreen, regression_suite: regressionSuite,
    suite_out: tail(suite.stdout + '\n' + suite.stderr, 40), metric: metric.value, metric_out: metric.out,
    failing: results.filter((r) => !r.pass).map((r) => ({ id: r.id, kind: r.kind, out: r.out })),
  }
}

const FAILURE_CLASSES = {
  code_bug: 'the implementation is wrong or incomplete: an assertion fails, wrong value, missing branch',
  compile_error: 'the code does not build, import, or type-check',
  environment: 'missing dependency, service, port, permission, or tool on the machine; not the code under test',
  flaky: 'nondeterministic: timing, ordering, network, randomness; passes on rerun',
  spec_gap: 'the test expects behaviour the spec does not define clearly, or two requirements contradict',
  timeout: 'the run exceeded its time limit or hung',
}

export async function classifyFailure(evalResult) {
  if (!evalResult.failing.length && evalResult.suite_green) return null
  const sample = evalResult.failing.slice(0, 4).map((f) => `[${f.id} ${f.kind}]\n${f.out}`).join('\n---\n') || evalResult.suite_out
  const r = await ask({ failing_output: sample.slice(-6000) }, { cause: choice('What is the most likely cause of this failing test run?', FAILURE_CLASSES) }, { purpose: 'failure-class' })
  const c = r.answers?.cause
  return c ? { cls: c.choice, confidence: c.confidence, lane: r.lane } : { cls: 'unknown', confidence: 0, lane: null }
}

export function firstErrorLine(out) {
  const lines = String(out).split('\n')
  return (lines.find((l) => /error|fail|assert|exception|panic|traceback/i.test(l)) || lines.filter(Boolean).slice(-1)[0] || '').trim().slice(0, 200)
}

export function writeIterLog(dir, n, data) {
  const p = path.join(dir, 'iterations', `${String(n).padStart(4, '0')}.json`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  return p
}
