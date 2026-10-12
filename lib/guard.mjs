// Scope guard, after the "Stop That Shit" idea (github.com/lennney/stop-that-shit, MIT): finish the
// requested work in full, and stop work nobody asked for. Only observable facts are enforced here;
// the judgement part (the Stop Ladder) lives in the skills and agent prompts.
//
//   I  intent    read-only review mode: no writes, no mutating shell commands
//   S  scope     writes outside the small plan's files; new dependencies without authority
//   H  hardening new hashing (hash APIs in code, hash shell tools) without authority
//   T  thrashing re-running a gate on a workspace that did not change (small.mjs, runner.mjs)
//
// Everything is deterministic (no LLM) and fails open: a guard bug never blocks the session.
import fs from 'node:fs'
import path from 'node:path'
import { HOME_FORGE, readJson, writeJson, appendJsonl, now, sha256, run } from './util.mjs'

// ---------- session mode (armed by /forge:review, /forge:change; /forge:guard off) ----------

const MODES = ['review', 'change']
function sessionFile(sid) { return path.join(HOME_FORGE, 'sessions', `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`) }

export function sessionMode(sid) {
  if (!sid) return null
  const s = readJson(sessionFile(sid), null)
  return s && MODES.includes(s.mode) ? s.mode : null
}

export function setSessionMode(sid, mode) {
  if (!sid) throw new Error('no session id')
  if (mode === 'off' || !mode) { try { fs.rmSync(sessionFile(sid)) } catch {} ; return null }
  if (!MODES.includes(mode)) throw new Error(`mode must be review, change or off`)
  writeJson(sessionFile(sid), { mode, since: now() })
  return mode
}

// A directive is the first non-empty line of the prompt: "/forge:review ...", "/forge:change ...".
// The forge: prefix is required (/review is a built-in Claude Code command).
export function parseDirective(prompt) {
  const m = /^\s*\/forge:(review|change)(?=$|[\s:])/i.exec(String(prompt || ''))
  return m ? m[1].toLowerCase() : null
}

// UserPromptExpansion carries the slash command separately.
export function expansionDirective(e) {
  if (e?.expansion_type && e.expansion_type !== 'slash_command') return null
  const m = /^forge:(review|change)$/i.exec(String(e?.command_name || ''))
  return m ? m[1].toLowerCase() : null
}

// ---------- shell analysis ----------

const READ_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'tree',
  'pwd', 'echo', 'printf', 'which', 'type', 'file', 'stat', 'du', 'df', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq',
  'date', 'env', 'printenv', 'whoami', 'uname', 'id', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test',
  '[', 'sleep', 'ps', 'free', 'nproc', 'column', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'awk', 'sed', 'find', 'git', 'cd',
  'curl', 'wget', 'man', 'help', 'history', 'lsof', 'netstat', 'ss', 'uptime', 'hostname', 'tput', 'clear', 'seq', 'expr'])
const WRITE_CMDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'ln', 'tee', 'dd',
  'truncate', 'install', 'patch', 'unzip', 'tar', 'shred', 'rsync', 'scp', 'kill', 'pkill', 'killall', 'systemctl', 'crontab'])
const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'describe',
  'shortlog', 'cat-file', 'merge-base', 'name-rev', 'rev-list', 'whatchanged', 'help', 'version', '--version', 'fetch'])
const WRAPPERS = new Set(['sudo', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout', 'xargs'])

function stripQuoted(s) { return s.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""') }
function segments(cmd) { return stripQuoted(String(cmd || '')).split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean) }

// Quote-aware split into commands and words (quoted text stays one word, separators inside
// quotes do not split). Used where the quoted content matters, e.g. package specs.
function tokenize(cmd) {
  const cmds = [[]]
  let cur = '', q = null, has = false
  const push = () => { if (has) cmds[cmds.length - 1].push(cur); cur = ''; has = false }
  const s = String(cmd || '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += ch; continue }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue }
    if (/\s/.test(ch) && ch !== '\n') { push(); continue }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && s[i + 1] === '&')) { push(); if (s[i + 1] === ch) i++; cmds.push([]); continue }
    cur += ch; has = true
  }
  push()
  return cmds.filter((c) => c.length)
}
function words(seg) {
  const w = seg.split(/\s+/).filter(Boolean)
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || WRAPPERS.has(w[0]) || /^\d+[smh]?$/.test(w[0]) && w.length > 1)) w.shift()
  return w
}
const isTestRunner = (w) => {
  const j = w.join(' ')
  return /^(npm|pnpm|yarn|bun)\s+(test|t|run\s+(test|lint|check|typecheck|build)[\w:-]*)\b/.test(j)
    || /^(npx|pnpx|bunx)\s+(vitest|jest|mocha|tsc|eslint|playwright|ava|tap)\b/.test(j)
    || /^node\s+--test\b/.test(j) || /^(pytest|py\.test|tox|nox)\b/.test(j) || /^python3?\s+-m\s+(pytest|unittest)\b/.test(j)
    || /^go\s+(test|vet|build)\b/.test(j) || /^cargo\s+(test|check|clippy|build)\b/.test(j)
    || /^make\s+(test|check|lint)\b/.test(j) || /^(mvn|gradle|\.\/gradlew)\s+(test|check|verify)\b/.test(j)
    || /^(rspec|phpunit|dotnet\s+test|mix\s+test|deno\s+test|ruff|mypy|flake8|black\s+--check)\b/.test(j)
}

function classifySegment(seg) {
  const w = words(seg)
  if (!w.length) return 'read'
  const c = path.basename(w[0])
  // forge's own CLI only writes forge state.
  if (c === 'node' && /bin\/forge\.mjs$/.test(w[1] || '')) return 'exec'
  if (/(^|\s)>>?\s*(?!&|\/dev\/(null|stderr|stdout)\b)\S/.test(seg) || /(^|\s)&>\s*(?!\/dev\/null)\S/.test(seg)) return 'write'
  if (isTestRunner(w)) return 'exec'
  if (c === 'git') {
    const sub = w.slice(1).find((x) => !x.startsWith('-')) || ''
    if (GIT_READ.has(sub)) return 'read'
    if (sub === 'branch' && !w.some((x) => /^-[dDmMcC]$|^--(delete|move|copy)$/.test(x)) && w.length <= 3) return 'read'
    if (['stash', 'worktree', 'remote', 'tag', 'config'].includes(sub) && /\b(list|-l|show|-v|--get)\b/.test(w.join(' '))) return 'read'
    return 'write'
  }
  if (c === 'sed') return w.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place') ? 'write' : 'read'
  if (c === 'awk') return /-i\s+inplace/.test(seg) ? 'write' : 'read'
  if (c === 'find') return w.some((x) => ['-delete', '-exec', '-execdir', '-ok', '-fprint'].includes(x)) ? 'write' : 'read'
  if (c === 'curl') return w.some((x) => /^-[a-zA-Z]*[oO]$|^--output$|^--remote-name/.test(x)) || w.some((x) => /^-X$|^--request$/.test(x)) && /\b(POST|PUT|PATCH|DELETE)\b/i.test(seg) ? 'write' : 'read'
  if (c === 'wget') return w.includes('-O-') || w.includes('--spider') ? 'read' : 'write'
  if (READ_CMDS.has(c)) return 'read'
  if (WRITE_CMDS.has(c)) return 'write'
  if (['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go', 'composer', 'bundle', 'gem', 'dotnet'].includes(c)) {
    const sub = w[1] || ''
    if (['ls', 'list', 'outdated', 'view', 'info', 'show', 'why', 'audit', 'search', 'freeze', 'version', '--version', '-v', 'help', 'env', 'doc'].includes(sub)) return 'read'
    return 'write'
  }
  return 'unknown'
}

// read < exec < unknown < write
export function classifyShell(cmd) {
  const rank = { read: 0, exec: 1, unknown: 2, write: 3 }
  let worst = 'read'
  for (const s of segments(cmd)) { const k = classifySegment(s); if (rank[k] > rank[worst]) worst = k }
  return worst
}

// Packages a shell command adds to the project (null when it adds none). "npm install" with no
// package, "pip install -r requirements.txt" and "pip install -e ." restore, they do not add.
export function shellDeps(cmd) {
  const out = []
  for (const toks of tokenize(cmd)) {
    const w = [...toks]
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || WRAPPERS.has(w[0]))) w.shift()
    const c = path.basename(w[0] || '')
    let args = null
    const sub = w[1]
    if (['npm', 'pnpm', 'bun'].includes(c) && ['add', 'install', 'i', 'in', 'isntall'].includes(sub)) args = w.slice(2)
    else if (c === 'yarn' && sub === 'add') args = w.slice(2)
    else if (['pip', 'pip3'].includes(c) && sub === 'install') args = w.slice(2)
    else if (/^python3?$/.test(c) && sub === '-m' && w[2] === 'pip' && w[3] === 'install') args = w.slice(4)
    else if (c === 'uv' && sub === 'pip' && w[2] === 'install') args = w.slice(3)
    else if (['uv', 'poetry', 'pdm', 'cargo', 'deno'].includes(c) && sub === 'add') args = w.slice(2)
    else if (c === 'go' && sub === 'get') args = w.slice(2)
    else if (c === 'composer' && sub === 'require') args = w.slice(2)
    else if (c === 'bundle' && sub === 'add') args = w.slice(2)
    else if (c === 'dotnet' && sub === 'add' && w.includes('package')) args = w.slice(w.indexOf('package') + 1)
    if (!args) continue
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '--prefix', '--target', '-t', '--index-url', '-i', '--registry', '--version'].includes(a)) { i++; continue }
      if (a.startsWith('-') || a === '.' || a.startsWith('./') || a.startsWith('/') || a === '""' || a === "''") continue
      const name = pkgName(a)
      if (name) out.push(name)
    }
  }
  return out.length ? [...new Set(out)] : null
}

// "@scope/pkg@^1" -> "@scope/pkg", "lodash@4" -> "lodash", "requests[socks]>=2" -> "requests",
// "github.com/x/y@v1.2.0" -> "github.com/x/y".
export function pkgName(spec) {
  const s = String(spec || '').replace(/^["']|["']$/g, '')
  if (s.startsWith('@')) { const m = /^(@[^/@]+\/[^@]+)/.exec(s); return m ? m[1] : null }
  return s.split('@')[0].replace(/\[.*$/, '').replace(/[<>=!~;,].*$/, '').trim() || null
}

const HASH_SHELL = /\b(?:md5sum|sha(?:1|224|256|384|512)sum|shasum|b2sum|cksum)\b|\bopenssl\s+dgst\b|\bcertutil\b[^\n]*-hashfile\b|\bGet-FileHash\b/i
export function shellHash(cmd) { return HASH_SHELL.test(stripQuoted(String(cmd || ''))) }

// ---------- file content intent (Edit / Write / MultiEdit) ----------

const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp|swift|scala|ex|exs)$/i
// Hash API recognition adapted from stop-that-shit src/hash-intent.cjs (MIT).
const HASH_API = /\b(?:createHash|createHmac)\s*\(|\bcrypto\.subtle\.digest\s*\(|\bhashlib\.(?:md5|sha1|sha224|sha256|sha384|sha512|blake2[bs]|new)\s*\(|\bMessageDigest\.getInstance\s*\(|\bDigestUtils\.[A-Za-z0-9_]+\s*\(|\bsha(?:1|256|512)\.(?:New|Sum\w*)\s*\(|\bmd5\.(?:New|Sum)\s*\(|\b(?:bcrypt|argon2)\.hash\s*\(|\bpassword_hash\s*\(|\bhash_file\s*\(|\bDigest::(?:SHA\d+|MD5)\b/g
const countHash = (s) => (String(s || '').match(HASH_API) || []).length

// The full file content after the tool runs, simulated from the current file.
export function contentAfter(tool, ti, abs) {
  let cur = ''
  try { cur = fs.readFileSync(abs, 'utf8') } catch {}
  if (tool === 'Write') return { before: cur, after: String(ti.content ?? '') }
  const edits = tool === 'MultiEdit' ? (ti.edits || []) : tool === 'Edit' ? [ti] : []
  let next = cur
  for (const e of edits) {
    const o = String(e.old_string ?? ''), n = String(e.new_string ?? '')
    if (!o) { next = n + next; continue }
    next = e.replace_all ? next.split(o).join(n) : next.replace(o, () => n)
  }
  return { before: cur, after: next }
}

function tomlDeps(text, file) {
  const names = new Set()
  let section = ''
  let inArray = false
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const h = /^\[\[?([^\]]+)\]\]?$/.exec(line)
    if (h) { section = h[1].replace(/["'\s]/g, ''); inArray = false; continue }
    const depSection = /(^|\.)((dev-|build-)?dependencies|dependency-groups|optional-dependencies)(\.|$)/.test(section)
    if (inArray) {
      for (const m of line.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)/g)) names.add(m[1].toLowerCase())
      if (line.includes(']')) inArray = false
      continue
    }
    const kv = /^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    if (/^\[/.test(kv[2]) && (file === 'pyproject.toml' && (section === 'project' && kv[1] === 'dependencies' || depSection))) {
      for (const m of kv[2].matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)/g)) names.add(m[1].toLowerCase())
      inArray = !kv[2].includes(']')
      continue
    }
    if (depSection && kv[1] !== 'python') names.add(kv[1].toLowerCase())
  }
  return names
}

// Dependency names declared by a manifest; null when the file is not a manifest or cannot be read.
export function manifestDeps(file, text) {
  const base = path.basename(String(file || '')).toLowerCase()
  if (base === 'package.json' || base === 'composer.json') {
    if (!String(text).trim()) return new Set()
    let j; try { j = JSON.parse(text) } catch { return null }
    const names = new Set()
    for (const f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'require', 'require-dev']) {
      if (j && typeof j[f] === 'object' && j[f]) for (const k of Object.keys(j[f])) names.add(k)
    }
    return names
  }
  if (/^requirements[^/]*\.(txt|in)$/.test(base)) {
    const names = new Set()
    for (const l of String(text).split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/.exec(l.replace(/#.*$/, ''))
      if (m && !l.trim().startsWith('-')) names.add(m[1].toLowerCase())
    }
    return names
  }
  if (base === 'pyproject.toml' || base === 'cargo.toml') return tomlDeps(text, base)
  if (base === 'go.mod') {
    const names = new Set()
    let block = false
    for (const l of String(text).split(/\r?\n/)) {
      const s = l.replace(/\/\/.*$/, '').trim()
      if (/^require\s*\($/.test(s)) { block = true; continue }
      if (block && s === ')') { block = false; continue }
      const m = block ? /^(\S+)\s+v\S+/.exec(s) : /^require\s+(\S+)\s+v\S+/.exec(s)
      if (m) names.add(m[1])
    }
    return names
  }
  if (base === 'gemfile') return new Set([...String(text).matchAll(/^\s*gem\s+["']([^"']+)/gm)].map((m) => m[1]))
  return null
}

// What a write would add: new dependency names and new hash API calls.
export function writeIntent(tool, ti, abs) {
  const out = { deps: null, hash: 0 }
  if (!abs) return out
  const { before, after } = contentAfter(tool, ti, abs)
  const a = manifestDeps(abs, after)
  if (a) {
    const b = manifestDeps(abs, before) || new Set()
    const added = [...a].filter((x) => !b.has(x))
    if (added.length) out.deps = added
  }
  if (CODE_PATH.test(abs)) out.hash = Math.max(0, countHash(after) - countHash(before))
  return out
}

// ---------- authority ----------

// allow = { deps: true | ["zod", ...], hash: true } from goal.json (large) or plan.json (small).
export function allowed(allow, kind, names = []) {
  const v = allow?.[kind]
  if (v === true) return true
  if (Array.isArray(v)) return names.length > 0 && names.every((n) => v.map((x) => String(x).toLowerCase()).includes(String(n).toLowerCase()))
  return false
}

// ---------- thrash ----------

// Fingerprint of the working tree: tracked changes against HEAD plus untracked files (gitignored
// files, .forge included, are not part of it). Same fingerprint = nothing changed.
export function workspaceFingerprint(root) {
  const d = run(['git', 'diff', 'HEAD', '--binary'], { cwd: root })
  if (d.code !== 0) return null
  const head = run(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
  const untracked = run(['git', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean).sort()
  let acc = head + '\n' + d.stdout
  for (const f of untracked) {
    let body = ''
    try { const st = fs.statSync(path.join(root, f)); body = st.size > 5e6 ? `size:${st.size}:${st.mtimeMs}` : fs.readFileSync(path.join(root, f), 'utf8') } catch {}
    acc += `\n--- ${f}\n${body}`
  }
  return sha256(acc)
}

// ---------- decision log ----------

const LOG = () => path.join(HOME_FORGE, 'logs', 'guard.jsonl')
const LABELS = () => path.join(HOME_FORGE, 'logs', 'guard-labels.jsonl')

// Metadata only: the rule, the decision and the target path or command head; never file content.
export function record(row) {
  const id = `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  try { appendJsonl(LOG(), { id, at: now(), ...row }) } catch {}
  return id
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

export function label(id, verdict) {
  if (!['correct', 'incorrect', 'unclear'].includes(verdict)) throw new Error('label must be correct, incorrect or unclear')
  if (!readJsonl(LOG()).some((r) => r.id === id)) throw new Error(`no guard event ${id}`)
  appendJsonl(LABELS(), { id, verdict, at: now() })
  return { id, verdict }
}

export function summary(n = 20) {
  const rows = readJsonl(LOG())
  const labels = new Map(readJsonl(LABELS()).map((l) => [l.id, l.verdict]))
  const by = {}
  for (const r of rows) {
    const k = `${r.rule}/${r.decision}`
    by[k] = by[k] || { count: 0, correct: 0, incorrect: 0 }
    by[k].count++
    const v = labels.get(r.id)
    if (v === 'correct') by[k].correct++
    if (v === 'incorrect') by[k].incorrect++
  }
  return { total: rows.length, by_rule: by, recent: rows.slice(-n).map((r) => ({ ...r, label: labels.get(r.id) || null })) }
}

export function cmdHead(cmd) { return stripQuoted(String(cmd || '')).trim().split(/\s+/).slice(0, 3).join(' ') }
