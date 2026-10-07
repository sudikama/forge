
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'
const d=fs.mkdtempSync(path.join(os.tmpdir(),'fdel-')); const rp=path.join(d,'report.md'); fs.writeFileSync(rp,'# hi\nbody')
process.env.FORGE_REPORT_CMD=`cp "$FORGE_REPORT_PATH" ${d}/copied.md && echo "$FORGE_REPORT_SUBJECT" > ${d}/subj`
const { deliver } = await import(path.resolve('lib/io.mjs'))
let got=null; const srv=http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{got=JSON.parse(b);s.end('ok')})}); await new Promise(r=>srv.listen(0,r))
const res=await deliver(['command',`webhook:http://127.0.0.1:${srv.address().port}/x`,'file','pager:1'],rp,'SUBJ-1'); srv.close()
let fail=0; const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)fail++}
ok('command ran', res[0].ok && fs.readFileSync(path.join(d,'copied.md'),'utf8')==='# hi\nbody' && fs.readFileSync(path.join(d,'subj'),'utf8').trim()==='SUBJ-1')
ok('webhook posted', res[1].ok && got?.subject==='SUBJ-1' && got?.report.includes('body'))
ok('file target', res[2].ok)
ok('unsupported target is reported', !res[3].ok && res[3].detail==='unknown target')
process.exit(fail?1:0)
