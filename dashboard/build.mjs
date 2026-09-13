// Build a self-contained dashboard from the rollover event log.
//   node dashboard/build.mjs [dir]      dir defaults to ~/.omo/rollover (or $OMO_ROLLOVER_DIR)
//   node dashboard/build.mjs --sample   uses dashboard/sample/
// Output: dashboard/out/index.html (data embedded, no server, Google Fonts only).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const arg = process.argv[2]
const dir = arg === "--sample" ? join(here, "sample") : arg || process.env.OMO_ROLLOVER_DIR || join(homedir(), ".omo", "rollover")
const jsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const sessDir = join(dir, "sessions")
const sessions = {}
for (const f of existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith(".jsonl")) : []) sessions[f.slice(0, -6)] = jsonl(join(sessDir, f))
const summary = jsonl(join(dir, "summary.jsonl"))
let budget = 150_000
try { budget = Number(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).budgetTokens) || budget } catch {}
const data = { dir, budget, generatedAt: new Date().toISOString(), sessions, summary }

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rollover Dashboard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#F4F2EC;--panel:#FFFFFF;--panel2:#ECE9E1;--line:#D8D3C7;--ink:#1B1F22;--ink2:#5B6166;--ink3:#8A9096;
 --ctx:#1F8F88;--ctxfill:rgba(31,143,136,.18);--budget:#D9930F;--child:#6E5FD9;--main:#2B6CB0;--handoff:#D9930F;--block:#C93F2A;--ok:#2F8F4E}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0F1418;--panel:#171E24;--panel2:#1F272E;--line:#2C3640;--ink:#E6EAE7;--ink2:#A7B0B6;--ink3:#6F7A82;
 --ctx:#3FB8AF;--ctxfill:rgba(63,184,175,.18);--budget:#F2B233;--child:#9B8CFF;--main:#5EA0E6;--handoff:#F2B233;--block:#E5573B;--ok:#4FBF74}}
:root[data-theme="dark"]{--bg:#0F1418;--panel:#171E24;--panel2:#1F272E;--line:#2C3640;--ink:#E6EAE7;--ink2:#A7B0B6;--ink3:#6F7A82;
 --ctx:#3FB8AF;--ctxfill:rgba(63,184,175,.18);--budget:#F2B233;--child:#9B8CFF;--main:#5EA0E6;--handoff:#F2B233;--block:#E5573B;--ok:#4FBF74}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "IBM Plex Sans",system-ui,sans-serif;padding-block:20px;padding-inline:clamp(16px,3vw,32px)}
.mono{font-family:"IBM Plex Mono",ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}
h1{font-size:22px;margin:0}
header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;align-items:flex-end;margin-bottom:16px}
.sub{color:var(--ink2);margin:4px 0 0}
button{font:inherit;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}
button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
button:focus-visible{outline:2px solid var(--ctx);outline-offset:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:16px;min-width:0}
.panel h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:0 0 10px;font-weight:500}
.chains{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.wrap{position:relative}
canvas{width:100%;display:block}
.tip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.15);display:none;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;color:var(--ink2);font-size:12px}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--c)}
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:right;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:var(--ink3);font-weight:500;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--panel2)}
.over{color:var(--budget);font-weight:500}
.empty{color:var(--ink2);padding:24px;text-align:center}
</style></head><body>
<header><div><h1>Rollover Dashboard</h1><p class="sub mono" id="meta"></p></div>
<div><button id="theme">theme: system</button></div></header>
<section class="panel"><h2>Session timeline</h2><div class="chains" id="chains"></div>
<div class="wrap"><canvas id="cv" height="420"></canvas><div class="tip mono" id="tip"></div></div>
<div class="legend"><span style="--c:var(--ctx)">context tokens</span><span style="--c:var(--budget)">budget</span><span style="--c:var(--main)">main turn</span><span style="--c:var(--handoff)">handoff turn / armed</span><span style="--c:var(--child)">wake sources active</span><span style="--c:var(--block)">task_create blocked</span></div></section>
<section class="panel"><h2>Trend across sessions</h2><div class="tbl"><table id="trend"><thead><tr><th>session</th><th>started</th><th>duration</th><th>messages</th><th>peak context</th><th>cacheRead / output</th><th>blocked</th><th>rollovers</th><th>ended</th></tr></thead><tbody></tbody></table></div></section>
<script>
const DATA=${JSON.stringify(data)};
(()=>{
const $=id=>document.getElementById(id),css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtK=n=>n>=1000?(n/1000).toFixed(n>=100000?0:1)+'K':String(n);
const dur=ms=>ms<60000?Math.round(ms/1000)+'s':ms<3600000?(ms/60000).toFixed(0)+'m':(ms/3600000).toFixed(1)+'h';
const S=DATA.sessions,ids=Object.keys(S);
$('meta').textContent=DATA.dir+' · '+ids.length+' sessions · built '+DATA.generatedAt.slice(0,16).replace('T',' ');
// chains: follow rollover.newSession links from roots
const next={},hasParent=new Set();
for(const id of ids)for(const e of S[id])if(e.ev==='rollover'&&e.newSession){next[id]=e.newSession;hasParent.add(e.newSession)}
const chains=ids.filter(id=>!hasParent.has(id)).map(r=>{const c=[r];while(next[c.at(-1)]&&S[next[c.at(-1)]]&&!c.includes(next[c.at(-1)]))c.push(next[c.at(-1)]);return c});
// per-session facts
function facts(id){const E=S[id],ms=E.filter(e=>e.ev==='message_end');const t0=Date.parse(E[0]?.t),t1=Date.parse(E.at(-1)?.t);
 const sum=DATA.summary.filter(s=>s.session===id).at(-1);
 return{id,t0,t1,messages:ms.length,peak:Math.max(0,...ms.map(m=>m.context||0)),cacheRead:ms.reduce((a,m)=>a+(m.cacheRead||0),0),output:ms.reduce((a,m)=>a+(m.output||0),0),
  blocked:E.filter(e=>e.ev==='tool_call_blocked').length,rollovers:E.filter(e=>e.ev==='rollover').length,ended:sum?sum.reason:'-'}}
// timeline
const cv=$('cv'),ctx=cv.getContext('2d'),tip=$('tip');let cur=chains[0]||[],pts=[];
function draw(){
 const W=cv.clientWidth,H=420,dpr=devicePixelRatio||1;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);pts=[];
 const ev=cur.flatMap(id=>S[id]||[]);if(!ev.length){ctx.fillStyle=css('--ink2');ctx.font='13px "IBM Plex Sans"';ctx.fillText('no events',20,40);return}
 const times=ev.map(e=>Date.parse(e.t)),t0=Math.min(...times),t1=Math.max(...times)+1000,padL=48,padR=16;
 const x=t=>padL+(t-t0)/(t1-t0)*(W-padL-padR);
 const cTop=12,cBot=230,maxTok=Math.max(DATA.budget*1.2,...ev.filter(e=>e.ev==='message_end').map(e=>e.context||0))*1.05;
 const y=v=>cBot-Math.min(v,maxTok)/maxTok*(cBot-cTop);
 ctx.font='11px "IBM Plex Mono"';ctx.textAlign='right';ctx.lineWidth=1;
 const step=maxTok>300000?100000:50000;for(let v=0;v<=maxTok;v+=step){ctx.fillStyle=css('--ink3');ctx.fillText(fmtK(v),padL-6,y(v)+4);ctx.strokeStyle=css('--line');ctx.beginPath();ctx.moveTo(padL,y(v));ctx.lineTo(W-padR,y(v));ctx.stroke()}
 // session boundaries
 let cum=0;for(const id of cur){const E=S[id];if(!E.length)continue;const xs=x(Date.parse(E[0].t));ctx.strokeStyle=css('--ink3');ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(xs,cTop);ctx.lineTo(xs,H-4);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=css('--ink2');ctx.textAlign='left';ctx.fillText(id,xs+4,H-8);cum++}
 // context area, one segment per session
 for(const id of cur){const ms=(S[id]||[]).filter(e=>e.ev==='message_end');if(!ms.length)continue;
  ctx.beginPath();ctx.moveTo(x(Date.parse(ms[0].t)),cBot);for(const m of ms)ctx.lineTo(x(Date.parse(m.t)),y(m.context||0));ctx.lineTo(x(Date.parse(ms.at(-1).t)),cBot);ctx.closePath();ctx.fillStyle=css('--ctxfill');ctx.fill();
  ctx.beginPath();ms.forEach((m,i)=>{const px=x(Date.parse(m.t)),py=y(m.context||0);i?ctx.lineTo(px,py):ctx.moveTo(px,py);pts.push({px,py,m})});ctx.strokeStyle=css('--ctx');ctx.lineWidth=2;ctx.stroke()}
 // budget
 ctx.strokeStyle=css('--budget');ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(padL,y(DATA.budget));ctx.lineTo(W-padR,y(DATA.budget));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=css('--budget');ctx.textAlign='left';ctx.fillText('budget '+fmtK(DATA.budget),padL+4,y(DATA.budget)-4);
 // main lane: turn = previous settle/message → message_end; handoff turn after handoff_requested
 const mY=260,mH=20;ctx.fillStyle=css('--ink3');ctx.textAlign='right';ctx.fillText('main',padL-6,mY+14);ctx.fillStyle=css('--panel2');ctx.fillRect(padL,mY,W-padL-padR,mH);
 for(const id of cur){let prev=null,handoff=false;for(const e of S[id]||[]){const t=Date.parse(e.t);
  if(e.ev==='handoff_requested')handoff=true;
  if(e.ev==='message_end'){if(prev!=null){ctx.fillStyle=handoff?css('--handoff'):css('--main');ctx.fillRect(x(prev),mY+3,Math.max(2,x(t)-x(prev)),mH-6)}prev=t;handoff=false}
  else if(e.ev==='agent_settled'||e.ev==='session_start'||e.ev==='handoff_requested')prev=t;
  if(e.ev==='tool_call_blocked'){ctx.fillStyle=css('--block');ctx.beginPath();ctx.moveTo(x(t),mY-2);ctx.lineTo(x(t)-4,mY-9);ctx.lineTo(x(t)+4,mY-9);ctx.closePath();ctx.fill()}
  if(e.ev==='armed'||e.ev==='rollover'){ctx.strokeStyle=css('--handoff');ctx.lineWidth=e.ev==='rollover'?2:1;ctx.beginPath();ctx.moveTo(x(t),cTop);ctx.lineTo(x(t),mY+mH);ctx.stroke();ctx.fillStyle=css('--handoff');ctx.textAlign='left';ctx.fillText(e.ev==='armed'?'armed:'+e.reason:'rollover',x(t)+3,cTop+10)}}}
 // wake lane: step chart of total
 const wY=300,wH=80;ctx.fillStyle=css('--ink3');ctx.textAlign='right';ctx.fillText('wake',padL-6,wY+wH/2);
 const ws=ev.filter(e=>e.ev==='wake_source_state'&&typeof e.total==='number');const wMax=Math.max(1,...ws.map(e=>e.total));
 for(let v=0;v<=wMax;v++){ctx.fillStyle=css('--ink3');ctx.fillText(String(v),padL-6,wY+wH-v/wMax*wH+4)}
 if(ws.length){ctx.beginPath();let lastX=x(Date.parse(ws[0].t)),lastY=wY+wH;ctx.moveTo(lastX,lastY);for(const e of ws){const px=x(Date.parse(e.t)),py=wY+wH-e.total/wMax*wH;ctx.lineTo(px,lastY);ctx.lineTo(px,py);lastX=px;lastY=py}ctx.lineTo(x(t1),lastY);ctx.lineTo(x(t1),wY+wH);ctx.closePath();ctx.fillStyle=css('--child');ctx.globalAlpha=.3;ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=css('--child');ctx.lineWidth=2;ctx.stroke()}
}
cv.onmousemove=e=>{const r=cv.getBoundingClientRect(),mx=e.clientX-r.left;let best=null;for(const p of pts)if(!best||Math.abs(p.px-mx)<Math.abs(best.px-mx))best=p;
 if(!best||Math.abs(best.px-mx)>12){tip.style.display='none';return}const m=best.m;
 tip.innerHTML=m.t.slice(11,19)+' · '+m.session+'<br>context '+fmtK(m.context||0)+' · in '+fmtK(m.input||0)+' · cacheRead '+fmtK(m.cacheRead||0)+' · out '+fmtK(m.output||0);
 tip.style.display='block';tip.style.left=Math.min(best.px+10,r.width-tip.offsetWidth-4)+'px';tip.style.top=(best.py-8)+'px'};
cv.onmouseleave=()=>tip.style.display='none';
function pick(chain){cur=chain;for(const b of $('chains').children)b.setAttribute('aria-pressed',String(b.dataset.root===chain[0]));draw()}
for(const c of chains){const b=document.createElement('button');b.className='mono';b.dataset.root=c[0];b.textContent=c.join(' → ');b.onclick=()=>pick(c);$('chains').appendChild(b)}
// trend table
const tb=$('trend').querySelector('tbody');
for(const f of ids.map(facts).sort((a,b)=>a.t0-b.t0)){const tr=document.createElement('tr');tr.className='mono';
 tr.innerHTML='<td>'+f.id+'</td><td>'+(isNaN(f.t0)?'-':new Date(f.t0).toISOString().slice(0,16).replace('T',' '))+'</td><td>'+(isNaN(f.t1)?'-':dur(f.t1-f.t0))+'</td><td>'+f.messages+'</td><td class="'+(f.peak>=DATA.budget?'over':'')+'">'+fmtK(f.peak)+'</td><td>'+(f.output?(f.cacheRead/f.output).toFixed(1):'-')+'</td><td>'+f.blocked+'</td><td>'+f.rollovers+'</td><td>'+f.ended+'</td>';
 tr.onclick=()=>pick(chains.find(c=>c.includes(f.id))||[f.id]);tb.appendChild(tr)}
if(!ids.length)tb.innerHTML='<tr><td colspan="9" class="empty">no sessions logged yet</td></tr>';
// theme toggle: system → light → dark
const modes=['system','light','dark'];let mi=0;$('theme').onclick=()=>{mi=(mi+1)%3;const m=modes[mi];if(m==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=m;$('theme').textContent='theme: '+m;draw()};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',draw);addEventListener('resize',draw);
if(cur.length)pick(cur);else draw();
})();
</script></body></html>`

const out = join(here, "out")
mkdirSync(out, { recursive: true })
writeFileSync(join(out, "index.html"), html)
console.log(`dashboard: ${Object.keys(sessions).length} sessions, ${summary.length} summary rows from ${dir} -> ${join(out, "index.html")}`)
