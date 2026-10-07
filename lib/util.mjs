// Shared helpers: paths, json io, globbing, hashing, process execution.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const HOME_FORGE = process.env.FORGE_HOME || path.join(os.homedir(), '.forge')
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

export function readJson(p, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    if (fallback !== undefined) return fallback
    throw new Error(`cannot read ${p}: ${e.message}`)
  }
}

export function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

export function appendJsonl(p, row) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.appendFileSync(p, JSON.stringify(row) + '\n')
}

export function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function now() { return new Date().toISOString() }

// Glob -> RegExp. Supports **, *, ?, and a trailing "/" meaning "everything under".
export function globToRegex(glob) {
  let g = glob.replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

export function matchAny(rel, globs = []) {
  const r = rel.replace(/^\.\//, '')
  return globs.some((g) => globToRegex(g).test(r))
}

export function run(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, encoding: 'utf8',
    timeout: (opts.timeoutSec || 600) * 1000, maxBuffer: 64 * 1024 * 1024, input: opts.input,
  })
  return { code: r.status ?? (r.signal ? 124 : 1), stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, error: r.error?.message }
}

export function sh(cmd, opts = {}) {
  return run(['bash', '-lc', cmd], opts)
}

export function git(args, cwd) {
  const r = run(['git', ...args], { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout.trim()
}

export function repoRoot(cwd = process.cwd()) {
  const r = run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  return r.code === 0 ? r.stdout.trim() : cwd
}

export function repoSlug(root) {
  const r = run(['git', 'remote', 'get-url', 'origin'], { cwd: root })
  const src = r.code === 0 ? r.stdout.trim() : root
  return path.basename(src).replace(/\.git$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

export function tail(s, n = 60) {
  const lines = String(s).split('\n')
  return lines.slice(-n).join('\n')
}

export function die(msg, code = 1) {
  process.stderr.write(`forge: ${msg}\n`)
  process.exit(code)
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2)
      if (v !== undefined) out[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[k] = argv[++i]
      else out[k] = true
    } else out._.push(a)
  }
  return out
}

// Plugin options arrive as CLAUDE_PLUGIN_OPTION_<KEY>; a plain env var or ~/.forge/env also works.
export function option(key, fallback) {
  const envKey = key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
  for (const k of [`CLAUDE_PLUGIN_OPTION_${key}`, `CLAUDE_PLUGIN_OPTION_${envKey}`, `FORGE_${envKey}`]) {
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k]
  }
  const file = forgeEnv()
  if (file[`FORGE_${envKey}`] !== undefined) return file[`FORGE_${envKey}`]
  return fallback
}

let envCache
export function forgeEnv() {
  if (envCache) return envCache
  envCache = {}
  for (const p of [path.join(HOME_FORGE, 'env')]) {
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) envCache[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return envCache
}

export function secret(name) {
  return process.env[name] || process.env[`CLAUDE_PLUGIN_OPTION_${name}`] || forgeEnv()[name] || ''
}
