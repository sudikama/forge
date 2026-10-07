#!/usr/bin/env bash
# Builds the E2E fixture repo for forge: a tiny node shop lib with an existing (regression)
# suite, locked acceptance tests written at the base commit, and a deterministic metric.
set -euo pipefail
R=${1:-${TMPDIR:-/tmp}/forge-e2e/shop}
rm -rf "$R"; mkdir -p "$R"/{src,tests,bench}
cd "$R"
git init -q -b main
git config user.name tester; git config user.email t@t

cat > src/price.mjs <<'EOF'
export let WORK = 0
// total of items [{price, qty}], qty defaults to 1. Deliberately quadratic (dedupe by scan).
export function total(items) {
  WORK = 0
  const seen = []
  let sum = 0
  for (const it of items) {
    let dup = false
    for (const s of seen) { WORK++; if (s === it) dup = true }
    seen.push(it)
    if (!dup) sum += it.price * (it.qty ?? 1)
  }
  return Math.round(sum * 100) / 100
}
EOF

cat > src/fmt.mjs <<'EOF'
export function plain(n) { return String(n) }
EOF

cat > src/report.mjs <<'EOF'
import { total } from './price.mjs'
export function line(items) { return `TOTAL ${total(items)}` }
EOF

cat > tests/existing.test.mjs <<'EOF'
import test from 'node:test'
import assert from 'node:assert/strict'
import { line } from '../src/report.mjs'
import { total } from '../src/price.mjs'
test('report line', () => assert.equal(line([{ price: 2, qty: 3 }, { price: 1.5 }]), 'TOTAL 7.5'))
test('qty defaults to 1', () => assert.equal(total([{ price: 4 }]), 4))
test('same object counted once', () => { const a = { price: 3, qty: 1 }; assert.equal(total([a, a]), 3) })
EOF

cat > tests/ac1.test.mjs <<'EOF'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as P from '../src/price.mjs'
test('ac1 happy', () => assert.equal(P.totalWithTax([{ price: 100, qty: 2 }], 0.11), 222))
test('ac1 unhappy', () => { assert.equal(typeof P.totalWithTax, 'function'); assert.throws(() => P.totalWithTax([{ price: 1 }], -0.1), RangeError) })
test('ac1 edge', () => assert.equal(P.totalWithTax([], 0.11), 0))
EOF

cat > tests/ac2.test.mjs <<'EOF'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as F from '../src/fmt.mjs'
test('ac2 happy', () => assert.equal(F.money(1234.5), 'Rp 1.234,50'))
test('ac2 unhappy', () => { assert.equal(typeof F.money, 'function'); assert.throws(() => F.money(Number.NaN), /needs a number/) })
test('ac2 edge', () => { assert.equal(F.money(0), 'Rp 0,00'); assert.equal(F.money(-5), '-Rp 5,00') })
EOF

cat > tests/ac3.test.mjs <<'EOF'
import test from 'node:test'
import assert from 'node:assert/strict'
test('ac3 happy', async () => { const C = await import('../src/currency.mjs'); assert.equal(C.toUSD(16000), '$1.00') })
EOF

cat > bench/work.mjs <<'EOF'
import * as P from '../src/price.mjs'
const items = Array.from({ length: 1000 }, (_, i) => ({ price: i % 7, qty: 1 }))
P.total(items)
console.log(P.WORK)
EOF

cat > package.json <<'EOF'
{ "name": "shop", "type": "module", "private": true }
EOF
git add -A; git commit -qm "base: shop lib with existing suite, locked acceptance tests, work bench"
echo "$R"
