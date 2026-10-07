#!/usr/bin/env node
// Scripted stand-in for `claude -p` (FORGE_AGENT_CMD), so the loop machinery is tested
// deterministically: same env, same prompt files, same CLI the real agents use.
// Behaviour per iteration is fixed to exercise: regression discard, valid orchestrator
// decision, auto-BLOCKED invalid cite, out-of-scope proposal, locked-file rejection, keep.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const role = process.env.FORGE_ROLE
const iter = Number(process.env.FORGE_ITER)
const cwd = process.env.FORGE_WORKTREE
const prompt = fs.readFileSync(process.env.FORGE_PROMPT_FILE, 'utf8')
const taskDir = process.env.FORGE_TASK_DIR
const FORGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../bin/forge.mjs')
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text) }
const finding = (args) => execFileSync('node', [FORGE, 'finding', '--task-dir', taskDir, ...args], { cwd, env: process.env, stdio: 'inherit' })
const log = (m) => console.log(`[stub ${role} ${process.env.FORGE_LANE || ''} iter ${iter} model=${process.env.FORGE_MODEL || '-'} effort=${process.env.FORGE_EFFORT || '-'}] ${m}`)

const PRICE_BUGGY = `export let WORK = 0
export function total(items) {
  WORK = 0
  let sum = 0
  for (const it of items) { WORK++; sum += it.price * it.qty }
  return Math.round(sum * 100) / 100
}
export function totalWithTax(items, rate) {
  if (rate < 0) throw new RangeError('rate must be >= 0')
  return Math.round(total(items) * (1 + rate) * 100) / 100
}
`
const PRICE_GOOD = `export let WORK = 0
export function total(items) {
  WORK = 0
  const seen = new Set()
  let sum = 0
  for (const it of items) { WORK++; if (seen.has(it)) continue; seen.add(it); sum += it.price * (it.qty ?? 1) }
  return Math.round(sum * 100) / 100
}
export function totalWithTax(items, rate) {
  if (!(rate >= 0)) throw new RangeError('rate must be >= 0')
  return Math.round(total(items) * (1 + rate) * 100) / 100
}
`
const FMT_GOOD = `export function plain(n) { return String(n) }
export function money(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) throw new TypeError('money() needs a number')
  const neg = n < 0
  const [i, d] = Math.abs(n).toFixed(2).split('.')
  return (neg ? '-' : '') + 'Rp ' + i.replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.') + ',' + d
}
`

if (role === 'orchestrator') {
  const file = prompt.match(/nothing else on the line\):\n\n\s+(\S+)\n/)[1]
  const f = JSON.parse(prompt.split('## Finding\n')[1].split('\n\n## Spec')[0])
  const specLines = fs.readFileSync(path.join(taskDir, 'spec.md'), 'utf8').split('\n')
  const ac1 = specLines.findIndex((l) => l.includes('AC-1:')) + 1
  const d = f.kind === 'spec_gap'
    ? { decision: 'proceed', cite: `spec.md:L${ac1}`, instruction: 'negative rate throws RangeError, as AC-1 says', reason: 'AC-1 settles it' }
    : { decision: 'proceed', cite: 'spec.md:L999', instruction: 'guess a USD rate', reason: 'seems fine' } // invalid cite: must become BLOCKED
  fs.writeFileSync(file, JSON.stringify(d))
  log(`decided ${f.id} ${d.decision} cite ${d.cite}`)
  process.exit(0)
}

const items = [...prompt.matchAll(/^- (W\d+) \[/gm)].map((m) => m[1])
log(`items ${items.join(',')}`)
// Ladder scenario: every model writes a broken W2, so the item must climb and finally block.
if (process.env.FORGE_STUB_MODE === 'w2-always-broken') {
  if (items.includes('W1')) w('src/price.mjs', PRICE_GOOD)
  if (items.includes('W2')) w('src/fmt.mjs', `export function plain(n) { return String(n) }\nexport function money(n) { return 'Rp ' + n } // ${process.env.FORGE_MODEL} iter ${iter}\n`)
  process.exit(0)
}
if (items.includes('W1')) {
  if (iter === 1) {
    w('src/price.mjs', PRICE_BUGGY) // linear but drops the qty default: breaks the existing suite
    finding(['--kind', 'spec_gap', '--title', 'negative tax rate: throw or clamp to 0?', '--evidence', 'spec AC-1 vs src/price.mjs', '--item', 'W1', '--options', 'throw|clamp'])
  } else w('src/price.mjs', PRICE_GOOD)
}
if (items.includes('W2')) {
  w('src/fmt.mjs', FMT_GOOD)
  if (iter === 1) {
    finding(['--kind', 'preexisting_bug', '--title', 'report.line ignores currency formatting', '--evidence', 'src/report.mjs:2 prints raw number'])
    finding(['--kind', 'other', '--title', 'report output should use money() formatting', '--evidence', 'src/report.mjs:2 prints a raw number; money() exists now'])
    finding(['--kind', 'ambiguity', '--title', 'USD rate source for AC-3 is not defined', '--evidence', 'spec AC-3 names no rate source; no config in repo', '--item', 'W3', '--options', 'fixed 16000|env var|API'])
  }
  if (iter === 2) w('tests/existing.test.mjs', '// lane b "simplified" the existing suite\n') // locked: lane must be rejected
}
process.exit(0)
