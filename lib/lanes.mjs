// Worker-count recommendation from the worklist: cluster items that would collide,
// order clusters by dependencies, then simulate 1..cap lanes and pick the smallest
// lane count whose makespan is within tolerance of the best. No item ever shares a
// file with another lane, so ownership can be enforced per lane.
import fs from 'node:fs'
import os from 'node:os'
import { matchAny, run, globToRegex } from './util.mjs'

const SIZE = { S: 1, M: 2, L: 4 }
// Files every slice tends to touch; they belong to the integrator, never to a lane.
export const HOT_DEFAULT = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.mod', 'go.sum',
  'requirements*.txt', 'pyproject.toml', 'poetry.lock', 'Cargo.toml', 'Cargo.lock', '**/migrations/**', '**/__manifest__.py', '**/routes.*', '**/router.*']

function isGlob(s) { return /[*?]/.test(s) || s.endsWith('/') }

function expand(globs, files) {
  const set = new Set()
  for (const g of globs || []) {
    if (!isGlob(g)) set.add(g.replace(/^\.\//, ''))
    const re = globToRegex(g)
    for (const f of files) if (re.test(f)) set.add(f)
  }
  return set
}

function prefixOverlap(a, b) {
  // Two globs that expand to nothing yet (new files) still collide when one's literal
  // prefix contains the other's.
  const lit = (g) => g.replace(/^\.\//, '').split(/[*?]/)[0]
  const pa = lit(a); const pb = lit(b)
  return pa.startsWith(pb) || pb.startsWith(pa)
}

export function memCap(perWorkerMb = 1200, reserveMb = 1500) {
  let avail = os.freemem() / 1048576
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)
    if (m) avail = Number(m[1]) / 1024
  } catch {}
  return { cap: Math.max(1, Math.floor((avail - reserveMb) / perWorkerMb)), availMb: Math.round(avail) }
}

export function plan(worklist, { root, hardCap = 4, quotaCap = 4, hot = HOT_DEFAULT, tolerance = 0.1, memPerWorkerMb = 1200 } = {}) {
  const files = root ? run(['git', 'ls-files'], { cwd: root }).stdout.split('\n').filter(Boolean) : []
  const items = (worklist.items || []).map((it) => ({
    ...it,
    w: SIZE[it.size] || 2,
    owned: [...expand(it.writes, files)].filter((f) => !matchAny(f, hot)),
    shared: [...new Set([...(it.shared || []), ...[...expand(it.writes, files)].filter((f) => matchAny(f, hot))])],
  }))

  // Union-find over write collisions.
  const parent = new Map(items.map((i) => [i.id, i.id]))
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)))
  const union = (a, b) => parent.set(find(a), find(b))
  const collisions = []
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]; const B = items[j]
      const sameFile = A.owned.filter((f) => B.owned.includes(f))
      const globHit = (A.writes || []).some((a) => (B.writes || []).some((b) => isGlob(a) && isGlob(b) && prefixOverlap(a, b)))
      if (sameFile.length || globHit) {
        union(A.id, B.id)
        collisions.push({ a: A.id, b: B.id, files: sameFile.slice(0, 5), glob: globHit && !sameFile.length })
      }
    }
  }
  const clusters = new Map()
  for (const it of items) {
    const r = find(it.id)
    if (!clusters.has(r)) clusters.set(r, { id: `C${clusters.size + 1}`, items: [], w: 0, deps: new Set(), owns: new Set(), writes: new Set() })
    const c = clusters.get(r)
    c.items.push(it.id); c.w += it.w
    it.owned.forEach((f) => c.owns.add(f)); (it.writes || []).filter((g) => !matchAny(g, hot)).forEach((g) => c.writes.add(g))
  }
  const clusterOf = new Map(items.map((it) => [it.id, clusters.get(find(it.id))]))
  for (const it of items) for (const d of it.depends_on || []) {
    const a = clusterOf.get(it.id); const b = clusterOf.get(d)
    if (a && b && a !== b) a.deps.add(b.id)
  }
  const cl = [...clusters.values()]

  // Critical path length (lower bound on makespan regardless of lanes).
  const byId = new Map(cl.map((c) => [c.id, c]))
  const memo = new Map()
  const cp = (c, seen = new Set()) => {
    if (memo.has(c.id)) return memo.get(c.id)
    if (seen.has(c.id)) throw new Error(`dependency cycle through ${c.id}`)
    seen.add(c.id)
    const v = c.w + Math.max(0, ...[...c.deps].map((d) => cp(byId.get(d), seen)))
    memo.set(c.id, v)
    return v
  }
  const critical = Math.max(0, ...cl.map((c) => cp(c)))
  const total = cl.reduce((s, c) => s + c.w, 0)

  const simulate = (W) => {
    const lanes = Array.from({ length: W }, (_, k) => ({ lane: String.fromCharCode(97 + k), free: 0, clusters: [] }))
    const done = new Map()
    const pending = [...cl].sort((a, b) => cp(b) - cp(a))
    while (pending.length) {
      const readyIdx = pending.findIndex((c) => [...c.deps].every((d) => done.has(d)))
      const c = pending.splice(readyIdx === -1 ? 0 : readyIdx, 1)[0]
      const earliest = Math.max(0, ...[...c.deps].map((d) => done.get(d) || 0))
      lanes.sort((x, y) => Math.max(x.free, earliest) - Math.max(y.free, earliest))
      const L = lanes[0]
      const start = Math.max(L.free, earliest)
      L.free = start + c.w
      L.clusters.push(c.id)
      done.set(c.id, L.free)
    }
    lanes.sort((x, y) => x.lane.localeCompare(y.lane))
    const makespan = Math.max(...lanes.map((l) => l.free))
    return { W, makespan, utilization: +(total / (W * makespan || 1)).toFixed(2), lanes: lanes.filter((l) => l.clusters.length) }
  }

  const mem = memCap(memPerWorkerMb)
  const cap = Math.max(1, Math.min(hardCap, quotaCap, mem.cap, cl.length))
  const options = []
  for (let W = 1; W <= Math.min(hardCap, Math.max(1, cl.length)); W++) options.push({ ...simulate(W), allowed: W <= cap })
  const allowed = options.filter((o) => o.allowed)
  const best = Math.min(...allowed.map((o) => o.makespan))
  const pick = allowed.find((o) => o.makespan <= best * (1 + tolerance)) || allowed[0]

  const lanes = pick.lanes.map((l) => ({
    lane: l.lane,
    clusters: l.clusters,
    items: l.clusters.flatMap((cid) => byId.get(cid).items),
    owns: [...new Set(l.clusters.flatMap((cid) => [...byId.get(cid).writes]))],
  }))
  const shared = [...new Set(items.flatMap((i) => i.shared))]
  return {
    recommended_workers: pick.W,
    caps: { hard: hardCap, quota: quotaCap, memory: mem.cap, mem_available_mb: mem.availMb, clusters: cl.length },
    critical_path: critical, total_work: total,
    options: options.map(({ W, makespan, utilization, allowed: ok }) => ({ workers: W, makespan, utilization, allowed: ok })),
    clusters: cl.map((c) => ({ id: c.id, items: c.items, weight: c.w, depends_on: [...c.deps] })),
    collisions, lanes,
    integrator: { owns: shared, note: 'shared/hot files are changed only by the orchestrator (integrator); lanes request changes via a finding' },
    rationale: `${items.length} items in ${cl.length} collision-free clusters; critical path ${critical}, total ${total}; ` +
      `picked ${pick.W} worker(s): smallest count within ${tolerance * 100}% of the best makespan (${best}) under cap ${cap}`,
  }
}
