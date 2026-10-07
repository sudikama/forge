// Source intake (frozen copies of what the task came from) and report delivery.
import fs from 'node:fs'
import path from 'node:path'
import { run, sha256File, now, secret } from './util.mjs'

function jiraEnv() {
  return { base: (secret('JIRA_BASE_URL') || '').replace(/\/$/, ''), email: secret('JIRA_EMAIL'), token: secret('JIRA_TOKEN') }
}

function adfToText(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (node.type === 'text') return node.text || ''
  const inner = (node.content || []).map(adfToText).join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
  if (node.type === 'listItem') return `- ${inner}`
  if (['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type)) return inner + '\n'
  return inner
}

export async function fetchJira(key) {
  const j = jiraEnv()
  if (!j.base || !j.email || !j.token) throw new Error('JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN not set (env or ~/.forge/env); or fetch it with the Jira MCP and pipe it into `forge source add --kind jira --ref KEY --stdin`')
  const auth = 'Basic ' + Buffer.from(`${j.email}:${j.token}`).toString('base64')
  const res = await fetch(`${j.base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,priority,labels,subtasks,comment,attachment,parent,issuelinks&expand=renderedFields`, { headers: { Authorization: auth, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Jira ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const it = await res.json()
  const f = it.fields || {}
  const lines = [
    `# ${it.key}: ${f.summary}`, '',
    `- type: ${f.issuetype?.name} | status: ${f.status?.name} | priority: ${f.priority?.name || '-'}`,
    f.parent ? `- parent: ${f.parent.key} ${f.parent.fields?.summary || ''}` : null,
    (f.labels || []).length ? `- labels: ${f.labels.join(', ')}` : null, '',
    '## Description', '', adfToText(f.description).trim() || '(empty)', '',
  ].filter((l) => l !== null)
  if ((f.subtasks || []).length) lines.push('## Subtasks', '', ...f.subtasks.map((s) => `- ${s.key} [${s.fields?.status?.name}] ${s.fields?.summary}`), '')
  if ((f.issuelinks || []).length) lines.push('## Links', '', ...f.issuelinks.map((l) => `- ${l.type?.name}: ${(l.outwardIssue || l.inwardIssue)?.key} ${(l.outwardIssue || l.inwardIssue)?.fields?.summary || ''}`), '')
  if ((f.attachment || []).length) lines.push('## Attachments (not downloaded)', '', ...f.attachment.map((a) => `- ${a.filename} (${a.mimeType}, ${a.size} bytes)`), '')
  const comments = f.comment?.comments || []
  if (comments.length) lines.push('## Comments', '', ...comments.map((c) => `### ${c.author?.displayName} ${c.created}\n\n${adfToText(c.body).trim()}\n`))
  return lines.join('\n') + '\n'
}

export function extractPdf(src) {
  const tries = [['pdftotext', '-layout', src, '-'], ['python3', '-c', 'import sys,fitz;d=fitz.open(sys.argv[1]);print("\\n".join(p.get_text() for p in d))', src]]
  for (const argv of tries) {
    const r = run(argv, { timeoutSec: 120 })
    if (r.code === 0 && r.stdout.trim()) return { text: r.stdout, via: argv[0] }
  }
  return { text: null, via: null }
}

export async function addSource(t, { kind, ref, file, stdinText, label }) {
  const dir = path.join(t.dir, 'source')
  fs.mkdirSync(dir, { recursive: true })
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  let out; let note = ''
  if (stdinText) {
    out = `${kind}-${safe(ref || label || 'stdin')}.md`
    fs.writeFileSync(path.join(dir, out), stdinText)
  } else if (kind === 'jira') {
    out = `jira-${safe(ref)}.md`
    fs.writeFileSync(path.join(dir, out), await fetchJira(ref))
  } else if (kind === 'pdf') {
    const base = safe(path.basename(file))
    fs.copyFileSync(file, path.join(dir, base))
    const x = extractPdf(file)
    if (x.text) { out = `${base}.txt`; fs.writeFileSync(path.join(dir, out), x.text); note = `extracted via ${x.via}` }
    else { out = base; note = 'no local PDF extractor: read it with the Read tool and pipe the text into `forge source add --kind pdf --ref <name> --stdin`' }
  } else if (['markdown', 'prd', 'file'].includes(kind)) {
    out = safe(path.basename(file))
    fs.copyFileSync(file, path.join(dir, out))
  } else if (['gdoc', 'figma'].includes(kind)) {
    throw new Error(`${kind} is read through its MCP server inside Claude Code; pipe the fetched content into: forge source add --kind ${kind} --ref <url-or-node> --stdin`)
  } else throw new Error(`unknown source kind ${kind} (jira|gdoc|pdf|markdown|prd|figma|file)`)
  const entry = { kind, ref: ref || file || label, file: out, sha256: sha256File(path.join(dir, out)), fetched: now(), note }
  t.sources = [...t.sources.filter((s) => s.file !== out), entry]
  return entry
}

// ---------- delivery ----------

export async function jiraComment(key, text) {
  const j = jiraEnv()
  if (!j.base || !j.token) throw new Error('Jira credentials not set')
  const auth = 'Basic ' + Buffer.from(`${j.email}:${j.token}`).toString('base64')
  const body = { body: { type: 'doc', version: 1, content: text.split('\n\n').slice(0, 60).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.slice(0, 3000) || ' ' }] })) } }
  const res = await fetch(`${j.base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`Jira comment ${key}: HTTP ${res.status}`)
  return (await res.json()).id
}

// targets: "telegram[:chat[:thread]]", "jira:KEY", "file" (always written anyway), "none".
export async function deliver(targets, reportPath, subject) {
  const results = []
  const text = fs.readFileSync(reportPath, 'utf8')
  for (const tgt of targets || []) {
    try {
      if (tgt.startsWith('telegram') || tgt.startsWith('discord') || tgt.startsWith('slack')) {
        const r = run(['hermes', 'send', '--to', tgt, '--subject', subject, '--file', reportPath, '--json'], { timeoutSec: 60 })
        results.push({ target: tgt, ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 200) })
      } else if (tgt.startsWith('jira:')) {
        const id = await jiraComment(tgt.slice(5), `${subject}\n\n${text}`)
        results.push({ target: tgt, ok: true, detail: `comment ${id}` })
      } else if (tgt === 'file' || tgt === 'none') {
        results.push({ target: tgt, ok: true, detail: reportPath })
      } else results.push({ target: tgt, ok: false, detail: 'unknown target' })
    } catch (e) { results.push({ target: tgt, ok: false, detail: e.message }) }
  }
  return results
}
