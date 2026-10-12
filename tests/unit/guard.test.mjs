// Scope guard unit tests, in Stop That Shit's bad/good pairs: every rule must stop the extra work
// (bad) AND let the necessary work through (good).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-'))
process.env.FORGE_HOME = path.join(W, 'home')
const G = await import(path.resolve('lib/guard.mjs'))

let fail = 0
const ok = (n, c, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ` ${extra}`}`); if (!c) fail++ }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const file = (rel, body) => { const p = path.join(W, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }

// I: shell mutability
for (const [cmd, want] of [
  ['git status && git diff HEAD~1', 'read'], ['grep -rn foo src | head', 'read'], ['cat a.txt > /dev/null', 'read'],
  ['ls -la; echo "rm -rf / > x"', 'read'], ['sed -n 1,20p src/a.js', 'read'], ['find . -name "*.js"', 'read'],
  ['npm test', 'exec'], ['npx vitest run', 'exec'], ['pytest -q tests/', 'exec'], ['go test ./...', 'exec'],
  ['echo hi > out.txt', 'write'], ['sed -i s/a/b/ x.js', 'write'], ['rm -rf build', 'write'], ['git commit -m x', 'write'],
  ['find . -name "*.tmp" -delete', 'write'], ['npm install', 'write'], ['curl -o x.zip http://e', 'write'],
  ['git branch -D old', 'write'], ['FOO=1 sudo mv a b', 'write'], ['./deploy.sh', 'unknown'], ['python3 script.py', 'unknown'],
]) ok(`shell ${want}: ${cmd}`, G.classifyShell(cmd) === want, `got ${G.classifyShell(cmd)}`)

// S: dependency intent from the shell (adds vs restores)
for (const [cmd, want] of [
  ['npm install', null], ['npm ci', null], ['pip install -r requirements.txt', null], ['pip install -e .', null],
  ['npm install lodash', ['lodash']], ['npm i -D @types/node@^20', ['@types/node']], ['pnpm add zod@3 ky', ['zod', 'ky']],
  ['yarn add react', ['react']], ['pip install "requests[socks]>=2.31"', ['requests']], ['python3 -m pip install httpx', ['httpx']],
  ['cargo add serde', ['serde']], ['go get github.com/pkg/errors@v0.9.1', ['github.com/pkg/errors']], ['uv add rich', ['rich']],
  ['echo "npm install lodash"', null],
]) ok(`deps ${cmd}`, eq(G.shellDeps(cmd), want), `got ${JSON.stringify(G.shellDeps(cmd))}`)

// S: dependency intent from manifest edits
const pkg = file('p/package.json', JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodash: '^4' }, scripts: { test: 'node --test' } }, null, 2))
let r = G.writeIntent('Edit', { old_string: '"lodash": "^4"', new_string: '"lodash": "^4",\n    "left-pad": "^1"' }, pkg)
ok('bad: package.json edit adds left-pad', eq(r.deps, ['left-pad']))
r = G.writeIntent('Edit', { old_string: '"lodash": "^4"', new_string: '"lodash": "^4.17.21"' }, pkg)
ok('good: version bump of an existing dep is not a new dep', r.deps === null)
r = G.writeIntent('Edit', { old_string: '"test": "node --test"', new_string: '"test": "node --test",\n    "lint": "eslint ."' }, pkg)
ok('good: adding a script is not a dep', r.deps === null)
r = G.writeIntent('Edit', { old_string: '"lodash": "^4"', new_string: '' }, pkg)
ok('good: removing a dep is allowed', r.deps === null)
const req = file('p/requirements.txt', 'requests==2.31\n# comment\n')
ok('bad: requirements.txt gains flask', eq(G.writeIntent('Write', { content: 'requests==2.31\nflask>=3\n' }, req).deps, ['flask']))
ok('good: requirements.txt pin change', G.writeIntent('Write', { content: 'requests==2.32.3\n' }, req).deps === null)
const py = file('p/pyproject.toml', '[project]\nname = "x"\nversion = "1.0.0"\ndependencies = [\n  "httpx>=0.27",\n]\n')
ok('bad: pyproject dependencies array gains rich', eq(G.writeIntent('Edit', { old_string: '  "httpx>=0.27",', new_string: '  "httpx>=0.27",\n  "rich",' }, py).deps, ['rich']))
ok('good: pyproject version bump', G.writeIntent('Edit', { old_string: 'version = "1.0.0"', new_string: 'version = "1.1.0"' }, py).deps === null)
const cargo = file('p/Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n')
ok('bad: Cargo.toml gains tokio', eq(G.writeIntent('Edit', { old_string: 'serde = "1"', new_string: 'serde = "1"\ntokio = { version = "1" }' }, cargo).deps, ['tokio']))
ok('good: Cargo package version is not a dep', G.writeIntent('Edit', { old_string: 'version = "0.1.0"', new_string: 'version = "0.2.0"' }, cargo).deps === null)
const gomod = file('p/go.mod', 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n')
ok('bad: go.mod gains a require', eq(G.writeIntent('Edit', { old_string: '\tgithub.com/a/b v1.0.0', new_string: '\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v0.2.0' }, gomod).deps, ['github.com/c/d']))
ok('good: non-manifest file is never a dep', G.writeIntent('Write', { content: '"dependencies": {"x": "1"}' }, file('p/notes.md', '')).deps === null)

// H: hashing (the README example: a checksum nobody reads)
const exp = file('p/src/export.mjs', 'import { writeFile } from "node:fs/promises"\nexport async function exportCsv(csv) {\n  await writeFile("report.csv", csv)\n}\n')
r = G.writeIntent('Edit', { old_string: '  await writeFile("report.csv", csv)', new_string: '  await writeFile("report.csv", csv)\n  await writeFile("report.csv.sha256", createHash("sha256").update(csv).digest("hex"))' }, exp)
ok('bad: unread sha256 sidecar is new hashing', r.hash === 1)
r = G.writeIntent('Edit', { old_string: 'export async', new_string: '// keep the output stable\nexport async' }, exp)
ok('good: unrelated edit is not hashing', r.hash === 0)
const already = file('p/src/verify.py', 'import hashlib\ndef digest(b):\n    return hashlib.sha256(b).hexdigest()\n')
ok('good: editing a file that already hashes adds none', G.writeIntent('Edit', { old_string: 'def digest(b):', new_string: 'def digest(b: bytes) -> str:' }, already).hash === 0)
ok('good: a hash word in prose is not hashing', G.writeIntent('Write', { content: 'createHash("sha256") is used upstream' }, file('p/docs.md', '')).hash === 0)
ok('bad: sha256sum in shell', G.shellHash('sha256sum dist/*.tar.gz > SHA256SUMS'))
ok('good: echo mentioning sha256sum is not hashing', !G.shellHash('echo "run sha256sum later"'))

// authority
ok('allow deps list covers named', G.allowed({ deps: ['zod'] }, 'deps', ['zod']))
ok('allow deps list misses others', !G.allowed({ deps: ['zod'] }, 'deps', ['zod', 'ky']))
ok('allow deps true', G.allowed({ deps: true }, 'deps', ['anything']))
ok('allow hash', G.allowed({ hash: true }, 'hash') && !G.allowed({}, 'hash'))

// directives
ok('directive /forge:review', G.parseDirective('\n  /forge:review the auth diff') === 'review')
ok('directive /forge:change', G.parseDirective('/forge:change: fix it') === 'change')
ok('built-in /review is not forge', G.parseDirective('/review this') === null)
ok('directive only on the first line', G.parseDirective('please\n/forge:review x') === null)
ok('expansion directive', G.expansionDirective({ expansion_type: 'slash_command', command_name: 'forge:review' }) === 'review')
G.setSessionMode('S-1', 'review'); ok('session mode stored', G.sessionMode('S-1') === 'review')
G.setSessionMode('S-1', 'off'); ok('session mode off', G.sessionMode('S-1') === null)

// log + labels
const id = G.record({ rule: 'HASH_NOT_AUTHORIZED', family: 'H', decision: 'deny', target: 'src/x.mjs' })
G.label(id, 'correct')
const sm = G.summary()
ok('log counts and labels', sm.total === 1 && sm.by_rule['HASH_NOT_AUTHORIZED/deny'].correct === 1)
ok('log keeps metadata only', !JSON.stringify(sm).includes('createHash'))

fs.rmSync(W, { recursive: true, force: true })
console.log(fail ? `guard: ${fail} FAILED` : 'guard: ALL PASS')
process.exit(fail ? 1 : 0)
