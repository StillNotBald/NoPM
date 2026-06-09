// Mainline SHELL prototype — one dataset, three switchable lenses (Subway / Journal /
// Network) over a shared control surface (layer toggles + project filter). Static,
// interactive (vanilla JS), built from the live demo seed. Output: scripts/mainline-shell.html
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const pick = async (t, c) => (await db.from(t).select(c).eq("workspace_id", W)).data ?? [];
const projects   = await pick("projects", "id, code, name, rag_status");
const milestones = await pick("milestones", "id, project_id, name, target_date, baseline_target_date, status, completion_pct");
const tasks      = await pick("tasks", "id, project_id, name, due_date, status_type, completion_pct");
const risks      = await pick("risks", "id, project_id, title, severity, raised_at, reference_id");
const issues     = await pick("issues", "id, project_id, title, priority, raised_at, reference_id");
const decisions  = await pick("decisions", "id, project_id, title, status, decided_at, created_at, reference_id");
const documents  = await pick("documents", "id, project_id, title, doc_type, status, created_at, reference_id");
const clashes    = await pick("clashes", "id, title, type, project_a_id, project_b_id, window_start, reference_id");

// theme
const CANVAS="#FAF9F5",SURFACE="#FFFFFF",INK="#2A2825",INK2="#6B6862",MUTED="#A8A39A",BORDER="#E7E2D8",CORAL="#D97757",GRID="#EFEBE2";
const PAL=["#3F8E7E","#5B6CB8","#C98A2B","#A65574","#4E7CA1","#7A8B3C"];
const order=[...projects].sort((a,b)=>(a.code||"").localeCompare(b.code||""));
const color={},pidx={}; order.forEach((p,i)=>{color[p.id]=PAL[i%PAL.length];pidx[p.id]=i;});
const pcode=Object.fromEntries(projects.map(p=>[p.id,p.code]));
const N=projects.length;
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const trunc=(s,n)=>{s=String(s??"");return s.length>n?s.slice(0,n-1)+"…":s;};
const Dt=s=>s?new Date(s):null;
const today="2026-06-09";
const SEV={low:"#3F8E7E",medium:"#C98A2B",high:"#D97757",critical:"#C0392B"};

// ---- time domain ----
const dates=[];
for(const m of milestones){if(m.target_date)dates.push(Dt(m.target_date));if(m.baseline_target_date)dates.push(Dt(m.baseline_target_date));}
for(const t of tasks){if(t.due_date)dates.push(Dt(t.due_date));}
for(const r of risks)if(r.raised_at)dates.push(Dt(r.raised_at));
let minD=new Date(Math.min(...dates)),maxD=new Date(Math.max(...dates));
minD.setDate(minD.getDate()-10);maxD.setDate(maxD.getDate()+14);
const DAY=86400000,span=Math.max(1,Math.round((maxD-minD)/DAY));
const DAYW=Math.min(7,Math.max(4,1500/span));

// ================= SUBWAY LENS (swimlanes by type, sub-lane per project) =================
function subwaySvg(){
  const LG=180,TA=60,RAIL_PAD=210,LH=110,INSET=16;
  const subGap=(LH-INSET*2)/N;
  const WIDTH=LG+span*DAYW+RAIL_PAD, HEIGHT=TA+7*LH+30;
  const lanes=[["milestone","Milestones"],["task","Tasks"],["risk","Risks"],["issue","Issues"],["decision","Decisions"],["doc","Docs"],["steerco","SteerCo"]];
  const x=s=>LG+(Dt(s)-minD)/DAY*DAYW;
  const bandTop=k=>TA+lanes.findIndex(l=>l[0]===k)*LH;
  const subY=(k,pid)=>bandTop(k)+INSET+(pidx[pid]+0.5)*subGap;
  const mid=k=>bandTop(k)+LH/2;
  let s="";
  // month grid + today
  { const d=new Date(minD.getFullYear(),minD.getMonth(),1);
    while(d<=maxD){const gx=x(d.toISOString().slice(0,10));
      s+=`<line x1="${gx.toFixed(1)}" y1="${TA-16}" x2="${gx.toFixed(1)}" y2="${HEIGHT-12}" stroke="${GRID}"/>`;
      s+=`<text x="${(gx+5).toFixed(1)}" y="${TA-20}" font-size="10" fill="${MUTED}" font-family="ui-monospace,monospace">${d.toLocaleDateString("en-GB",{month:"short",year:"2-digit"})}</text>`;
      d.setMonth(d.getMonth()+1);} }
  const steerco=[]; { const q=new Date(minD.getFullYear(),Math.ceil((minD.getMonth()+1)/3)*3,0);
    while(q<=maxD){const iso=q.toISOString().slice(0,10);steerco.push(iso);
      s+=`<rect class="lyr-steerco" x="${(x(iso)-3).toFixed(1)}" y="${TA-12}" width="6" height="${HEIGHT-TA}" fill="${CORAL}" opacity="0.09"/>`;q.setMonth(q.getMonth()+3);} }
  { const tx=x(today); s+=`<line x1="${tx.toFixed(1)}" y1="${TA-16}" x2="${tx.toFixed(1)}" y2="${HEIGHT-12}" stroke="${CORAL}" stroke-width="1.5" stroke-dasharray="3 3"/><rect x="${(tx-21).toFixed(1)}" y="${TA-34}" width="42" height="15" rx="3" fill="${CORAL}"/><text x="${tx.toFixed(1)}" y="${TA-23}" font-size="9" fill="#fff" text-anchor="middle" font-family="ui-monospace,monospace" font-weight="600">TODAY</text>`; }
  // bands + guides + labels
  for(const [k,label] of lanes){ const top=bandTop(k);
    s+=`<rect x="0" y="${top}" width="${WIDTH}" height="${LH}" fill="${lanes.findIndex(l=>l[0]===k)%2?"#00000000":"#0000000a"}"/>`;
    s+=`<text x="20" y="${top+LH/2-3}" font-size="12.5" font-weight="600" fill="${INK}" font-family="ui-sans-serif,system-ui">${label}</text>`;
    if(k!=="steerco")for(const p of order){const y=subY(k,p.id);s+=`<line class="lyr-${k}" x1="${LG}" y1="${y.toFixed(1)}" x2="${(WIDTH-RAIL_PAD+30).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color[p.id]}" stroke-width="1" opacity="0.13"/>`;}
    else s+=`<line x1="${LG}" y1="${mid("steerco").toFixed(1)}" x2="${(WIDTH-RAIL_PAD+30).toFixed(1)}" y2="${mid("steerco").toFixed(1)}" stroke="${BORDER}" stroke-width="1.5"/>`;
  }
  const dia=(cx,cy,r,f,st,sw)=>`<path d="M${cx} ${cy-r} L${cx+r} ${cy} L${cx} ${cy+r} L${cx-r} ${cy} Z" fill="${f}" stroke="${st}" stroke-width="${sw||1.8}"/>`;
  const tri=(cx,cy,r,f,st)=>`<path d="M${cx} ${cy-r} L${cx+r} ${cy+r} L${cx-r} ${cy+r} Z" fill="${f}" stroke="${st}" stroke-width="1.3" stroke-linejoin="round"/>`;
  const projMs={}; for(const m of milestones)if(m.target_date)(projMs[m.project_id]||=[]).push(m);
  for(const k in projMs)projMs[k].sort((a,b)=>Dt(a.target_date)-Dt(b.target_date));
  const nearest=(pid,iso)=>{const a=projMs[pid]||[];if(!a.length)return null;let b=a[0],bd=1/0;for(const m of a){const d=Math.abs(Dt(m.target_date)-Dt(iso||today));if(d<bd){bd=d;b=m;}}return b;};
  const critical=(projects.find(p=>p.rag_status==="red")||projects.find(p=>p.rag_status==="amber")||[...projects].sort((a,b)=>(projMs[b.id]?.length||0)-(projMs[a.id]?.length||0))[0])?.id;
  // milestone lines
  for(const p of order){const a=projMs[p.id]||[];if(!a.length)continue;const y=subY("milestone",p.id),cr=p.id===critical;
    for(let i=1;i<a.length;i++)s+=`<line class="lyr-milestone" x1="${x(a[i-1].target_date).toFixed(1)}" y1="${y.toFixed(1)}" x2="${x(a[i].target_date).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${cr?CORAL:color[p.id]}" stroke-width="${cr?4:2.5}" stroke-linecap="round" opacity="${cr?0.95:0.7}"/>`;
    s+=`<text class="lyr-milestone" x="${(x(a.at(-1).target_date)+14).toFixed(1)}" y="${(y+3).toFixed(1)}" font-size="10" font-weight="${cr?700:600}" fill="${cr?CORAL:INK}" font-family="ui-monospace,monospace">${esc(p.code)}${cr?" · critical":""}</text>`;}
  // stations
  for(const m of milestones){if(!m.target_date)continue;const cx=x(m.target_date),cy=subY("milestone",m.project_id);
    s+=`<g class="lyr-milestone st" data-proj="${m.project_id}"><title>${esc(m.name)} · ${esc(pcode[m.project_id])} · ${esc(m.status)}</title>${dia(cx,cy,6,color[m.project_id],"#fff")}</g>`;
    s+=`<text class="lyr-milestone" x="${cx}" y="${(cy-10).toFixed(1)}" font-size="8" fill="${INK2}" text-anchor="middle" font-family="ui-sans-serif,system-ui">${esc(trunc(m.name,13))}</text>`;}
  for(const t of tasks){if(!t.due_date)continue;const done=t.status_type==="completed";s+=`<g class="lyr-task st" data-proj="${t.project_id}"><title>${esc(t.name)} · ${esc(pcode[t.project_id])} · ${esc(t.status_type)}</title><circle cx="${x(t.due_date).toFixed(1)}" cy="${subY("task",t.project_id).toFixed(1)}" r="3.2" fill="${color[t.project_id]}" opacity="${done?0.9:0.4}"/></g>`;}
  for(const r of risks){if(!r.raised_at)continue;s+=`<g class="lyr-risk st" data-proj="${r.project_id}"><title>${esc(r.reference_id||"Risk")} · ${esc(r.title)} · ${esc(r.severity)}</title>${tri(x(r.raised_at),subY("risk",r.project_id),6,color[r.project_id],r.severity==="critical"?"#C0392B":"#fff")}</g>`;}
  for(const it of issues){if(!it.raised_at)continue;s+=`<g class="lyr-issue st" data-proj="${it.project_id}"><title>${esc(it.reference_id||"Issue")} · ${esc(it.title)} · ${esc(it.priority)}</title><circle cx="${x(it.raised_at).toFixed(1)}" cy="${subY("issue",it.project_id).toFixed(1)}" r="5" fill="${color[it.project_id]}" stroke="#fff"/></g>`;}
  for(const d of decisions){const dd=d.decided_at||d.created_at;if(!dd)continue;const cx=x(dd),cy=d.project_id?subY("decision",d.project_id):mid("decision"),c=d.project_id?color[d.project_id]:MUTED;s+=`<g class="lyr-decision st" data-proj="${d.project_id||""}"><title>${esc(d.reference_id||"Decision")} · ${esc(d.title)}</title><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6.5" fill="${SURFACE}" stroke="${c}" stroke-width="1.8"/>${dia(cx,cy,3,c,"none",0)}</g>`;}
  for(const dc of documents){if(!dc.created_at)continue;const cy=dc.project_id?subY("doc",dc.project_id):mid("doc");s+=`<g class="lyr-doc st" data-proj="${dc.project_id||""}"><title>${esc(dc.reference_id||"Doc")} · ${esc(dc.title)}</title><rect x="${(x(dc.created_at)-4).toFixed(1)}" y="${(cy-5.5).toFixed(1)}" width="8" height="11" rx="1.3" fill="${dc.project_id?color[dc.project_id]:MUTED}" stroke="#fff"/></g>`;}
  for(const iso of steerco){const cy=mid("steerco");s+=`<g class="lyr-steerco st"><title>SteerCo gate · ${new Date(iso).toLocaleDateString("en-GB",{month:"long",year:"numeric"})}</title><rect x="${(x(iso)-8).toFixed(1)}" y="${(cy-8).toFixed(1)}" width="16" height="16" rx="3" fill="${CORAL}" stroke="#fff" stroke-width="2"/></g><text class="lyr-steerco" x="${x(iso).toFixed(1)}" y="${(cy+24).toFixed(1)}" font-size="9" fill="${INK2}" text-anchor="middle" font-family="ui-monospace,monospace">${new Date(iso).toLocaleDateString("en-GB",{month:"short"})}</text>`;}
  for(const c of clashes){if(!c.project_a_id||!c.project_b_id)continue;const ma=nearest(c.project_a_id,c.window_start),mb=nearest(c.project_b_id,c.window_start);if(!ma||!mb)continue;const x1=x(ma.target_date),y1=subY("milestone",c.project_a_id),x2=x(mb.target_date),y2=subY("milestone",c.project_b_id),mx=(x1+x2)/2,my=(y1+y2)/2;s+=`<g class="lyr-milestone st"><title>${esc(c.reference_id||"Clash")} · ${esc(c.title)} · ${esc(pcode[c.project_a_id])} ⇄ ${esc(pcode[c.project_b_id])}</title><path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${mx.toFixed(1)} ${(my-22).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${INK2}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/><circle cx="${mx.toFixed(1)}" cy="${(my-22).toFixed(1)}" r="6" fill="${SURFACE}" stroke="${INK2}" stroke-width="2"/></g>`;}
  return `<svg width="${WIDTH.toFixed(0)}" height="${HEIGHT}" font-family="ui-sans-serif,system-ui"><rect width="${WIDTH.toFixed(0)}" height="${HEIGHT}" fill="${CANVAS}"/>${s}</svg>`;
}

// ================= JOURNAL LENS (vertical narrative feed) =================
function journalHtml(){
  const ev=[];
  for(const m of milestones)if(m.target_date)ev.push({d:m.target_date,k:"milestone",t:m.name,p:m.project_id,s:m.status,r:""});
  for(const t of tasks)if(t.due_date)ev.push({d:t.due_date,k:"task",t:t.name,p:t.project_id,s:t.status_type,r:""});
  for(const r of risks)if(r.raised_at)ev.push({d:r.raised_at,k:"risk",t:r.title,p:r.project_id,s:r.severity,r:r.reference_id});
  for(const it of issues)if(it.raised_at)ev.push({d:it.raised_at,k:"issue",t:it.title,p:it.project_id,s:it.priority,r:it.reference_id});
  for(const d of decisions){const dd=d.decided_at||d.created_at;if(dd)ev.push({d:dd,k:"decision",t:d.title,p:d.project_id,s:d.status,r:d.reference_id});}
  for(const dc of documents)if(dc.created_at)ev.push({d:dc.created_at,k:"doc",t:dc.title,p:dc.project_id,s:dc.status,r:dc.reference_id});
  { const m0=new Date(minD.getFullYear(),Math.ceil((minD.getMonth()+1)/3)*3,0); while(m0<=maxD){ev.push({d:m0.toISOString().slice(0,10),k:"steerco",t:"SteerCo gate",p:null,s:"",r:""});m0.setMonth(m0.getMonth()+3);} }
  ev.sort((a,b)=>Dt(b.d)-Dt(a.d));
  const GLYPH={milestone:"◇",task:"●",risk:"▲",issue:"⬢",decision:"◎",doc:"▭",steerco:"▣"};
  let out="",curMonth="";
  for(const e of ev){
    const mlabel=new Date(e.d).toLocaleDateString("en-GB",{month:"long",year:"numeric"});
    if(mlabel!==curMonth){curMonth=mlabel;out+=`<div class="jmonth">${mlabel}</div>`;}
    const c=e.p?color[e.p]:CORAL; const day=new Date(e.d).toLocaleDateString("en-GB",{day:"2-digit",month:"short"});
    out+=`<div class="jrow lyr-${e.k}" data-proj="${e.p||""}">`
      +`<span class="jday">${day}</span>`
      +`<span class="jglyph" style="color:${c}">${GLYPH[e.k]}</span>`
      +`<span class="jtitle">${e.r?'<b>'+esc(e.r)+'</b> ':''}${esc(trunc(e.t,72))}</span>`
      +(e.p?`<span class="jchip" style="background:${c}1a;color:${c}">${esc(pcode[e.p])}</span>`:`<span class="jchip" style="background:#D977571a;color:${CORAL}">PORTFOLIO</span>`)
      +`<span class="jstatus">${esc(e.s||"")}</span>`
    +`</div>`;
  }
  return `<div class="journal">${out}</div>`;
}

// ================= NETWORK LENS (project lanes + dependency/link edges + Trace) =================
function networkSvg(){
  const LG=150,TOP=40,laneH=84,colW=Math.min(150,Math.max(96,1100/Math.max(1,Math.max(...order.map(p=>(milestones.filter(m=>m.project_id===p.id).length))))));
  const WIDTH=1500,HEIGHT=TOP+N*laneH+40;
  const laneY=pid=>TOP+pidx[pid]*laneH+laneH/2;
  const projMs={}; for(const m of milestones)if(m.target_date)(projMs[m.project_id]||=[]).push(m);
  for(const k in projMs)projMs[k].sort((a,b)=>Dt(a.target_date)-Dt(b.target_date));
  const critical=(projects.find(p=>p.rag_status==="red")||projects.find(p=>p.rag_status==="amber")||[...projects].sort((a,b)=>(projMs[b.id]?.length||0)-(projMs[a.id]?.length||0))[0])?.id;
  const pos={}, nodes=[], edges=[];
  for(const p of order){const a=projMs[p.id]||[];a.forEach((m,i)=>{const cx=LG+i*colW+colW*0.5,cy=laneY(p.id);pos[m.id]=[cx,cy];nodes.push({id:m.id,kind:"milestone",x:cx,y:cy,c:color[p.id],label:trunc(m.name,12),proj:p.id});});}
  // sequence edges (+ critical)
  for(const p of order){const a=projMs[p.id]||[];for(let i=1;i<a.length;i++){edges.push([a[i-1].id,a[i].id,p.id===critical]);}}
  // risk/decision satellites linked to nearest milestone
  const nearest=(pid,iso)=>{const a=projMs[pid]||[];if(!a.length)return null;let b=a[0],bd=1/0;for(const m of a){const d=Math.abs(Dt(m.target_date)-Dt(iso||today));if(d<bd){bd=d;b=m;}}return b;};
  let sat=0;
  for(const r of risks.filter(r=>r.severity==="high"||r.severity==="critical")){const m=nearest(r.project_id,r.raised_at);if(!m||!pos[m.id])continue;const [mx,my]=pos[m.id];const cx=mx,cy=my-30-(sat%2)*8;pos[r.id]=[cx,cy];sat++;nodes.push({id:r.id,kind:"risk",x:cx,y:cy,c:SEV[r.severity]||color[r.project_id],label:r.reference_id||"R",proj:r.project_id,glyph:"tri"});edges.push([r.id,m.id,false]);}
  for(const d of decisions){const m=nearest(d.project_id,d.decided_at||d.created_at);if(!m||!pos[m.id])continue;const [mx,my]=pos[m.id];const cx=mx,cy=my+30;pos[d.id]=[cx,cy];nodes.push({id:d.id,kind:"decision",x:cx,y:cy,c:color[d.project_id]||MUTED,label:d.reference_id||"D",proj:d.project_id||"",glyph:"ring"});edges.push([d.id,m.id,false]);}
  for(const c of clashes){if(!c.project_a_id||!c.project_b_id)continue;const ma=nearest(c.project_a_id,c.window_start),mb=nearest(c.project_b_id,c.window_start);if(ma&&mb&&pos[ma.id]&&pos[mb.id])edges.push([ma.id,mb.id,false,"clash"]);}
  let s="";
  for(const p of order){const y=laneY(p.id);s+=`<rect x="0" y="${y-laneH/2}" width="${WIDTH}" height="${laneH}" fill="${pidx[p.id]%2?"#00000000":"#0000000a"}"/><text x="16" y="${y-laneH/2+16}" font-size="11" font-weight="600" font-family="ui-monospace,monospace" fill="${color[p.id]}">${esc(p.code)}</text>`;}
  for(const e of edges){const a=pos[e[0]],b=pos[e[1]];if(!a||!b)continue;const cl=e[3]==="clash";const mx=(a[0]+b[0])/2;s+=`<path data-edge="${e[0]}|${e[1]}" d="M${a[0]} ${a[1]} C${mx} ${a[1]} ${mx} ${b[1]} ${b[0]} ${b[1]}" fill="none" stroke="${cl?INK2:(e[2]?CORAL:"#bdb8ad")}" stroke-width="${e[2]?3:1.5}" stroke-dasharray="${cl?"5 3":"0"}" opacity="${e[2]?0.95:0.6}"/>`;}
  for(const n of nodes){const t=`<title>${esc(n.label)} · ${esc(pcode[n.proj]||"")}</title>`;
    let g; if(n.kind==="milestone")g=`<path d="M${n.x} ${n.y-7} L${n.x+7} ${n.y} L${n.x} ${n.y+7} L${n.x-7} ${n.y} Z" fill="${n.c}" stroke="#fff" stroke-width="1.6"/>`;
    else if(n.glyph==="tri")g=`<path d="M${n.x} ${n.y-6} L${n.x+6} ${n.y+6} L${n.x-6} ${n.y+6} Z" fill="${n.c}" stroke="#fff" stroke-width="1.2"/>`;
    else g=`<circle cx="${n.x}" cy="${n.y}" r="6.5" fill="${SURFACE}" stroke="${n.c}" stroke-width="1.8"/><circle cx="${n.x}" cy="${n.y}" r="2.5" fill="${n.c}"/>`;
    s+=`<g class="lyr-${n.kind} st" data-node="${n.id}" data-proj="${n.proj}">${t}${g}</g>`;
    if(n.kind==="milestone")s+=`<text x="${n.x}" y="${n.y-11}" font-size="8" fill="${INK2}" text-anchor="middle" font-family="ui-sans-serif,system-ui">${esc(n.label)}</text>`;}
  const edgeJson=JSON.stringify(edges.map(e=>[e[0],e[1]]));
  return {svg:`<svg id="net-svg" width="${WIDTH}" height="${HEIGHT}" font-family="ui-sans-serif,system-ui"><rect width="${WIDTH}" height="${HEIGHT}" fill="${CANVAS}"/>${s}</svg>`,edges:edgeJson};
}

const net=networkSvg();
const legendChips=order.map(p=>`<span class="lg"><i style="background:${color[p.id]}"></i><b>${esc(p.code)}</b> ${esc(trunc(p.name,22))}</span>`).join("");
const projOpts=`<option value="">All projects</option>`+order.map(p=>`<option value="${p.id}">${esc(p.code)} — ${esc(trunc(p.name,28))}</option>`).join("");
const LAYERS=[["milestone","Milestones"],["task","Tasks"],["risk","Risks"],["issue","Issues"],["decision","Decisions"],["doc","Docs"],["steerco","SteerCo"]];
const layerToggles=LAYERS.map(([k,l])=>`<label class="tg"><input type="checkbox" data-layer="${k}" checked> ${l}</label>`).join("");
const hideCss=LAYERS.map(([k])=>`body.hide-${k} .lyr-${k}{display:none!important}`).join("\n");

const html=`<!doctype html><html><head><meta charset="utf-8"><title>Mainline shell</title>
<style>
 *{box-sizing:border-box}
 body{margin:0;background:${CANVAS};color:${INK};font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 .hdr{padding:16px 22px 0}
 h1{font-size:19px;margin:0 0 2px;letter-spacing:-.01em}.sub{color:${INK2};font-size:12.5px;margin:0 0 12px}
 .bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 22px;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};background:${SURFACE};position:sticky;top:0;z-index:5}
 .switch{display:inline-flex;background:${CANVAS};border:1px solid ${BORDER};border-radius:9px;padding:3px}
 .switch button{border:0;background:transparent;font:inherit;font-size:13px;font-weight:600;color:${INK2};padding:6px 16px;border-radius:7px;cursor:pointer}
 .switch button.active{background:${CORAL};color:#fff}
 .ctrl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:${INK2}}
 .tg{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
 .tg input{accent-color:${CORAL}}
 select{font:inherit;font-size:12px;border:1px solid ${BORDER};border-radius:7px;padding:5px 8px;background:${SURFACE};color:${INK}}
 .sep{width:1px;height:20px;background:${BORDER}}
 .pill{font-size:11px;color:${MUTED}}
 .legend{display:flex;flex-wrap:wrap;gap:6px 16px;padding:8px 22px;font-size:11px;color:${INK2};border-bottom:1px solid ${BORDER}}
 .lg{display:inline-flex;align-items:center;gap:6px}.lg i{width:11px;height:11px;border-radius:3px;display:inline-block}
 .stage{padding:8px 14px 30px}
 .scroll{overflow:auto;max-height:calc(100vh - 200px);border:1px solid ${BORDER};border-radius:10px;background:${CANVAS}}
 svg .st{cursor:pointer;transition:transform .1s}svg .st:hover{transform:scale(1.45);transform-box:fill-box;transform-origin:center}
 #net-svg.tracing [data-node]{opacity:.13}#net-svg.tracing [data-node].hl{opacity:1}
 #net-svg.tracing [data-edge]{opacity:.06}
 .journal{max-width:860px;margin:0 auto;padding:10px 4px}
 .jmonth{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};margin:18px 0 6px;border-bottom:1px solid ${BORDER};padding-bottom:4px}
 .jrow{display:flex;align-items:center;gap:12px;padding:8px 8px;border-radius:8px;font-size:13.5px}
 .jrow:hover{background:${SURFACE}}
 .jday{width:54px;flex:none;color:${MUTED};font-family:ui-monospace,monospace;font-size:11px;text-align:right}
 .jglyph{width:16px;flex:none;text-align:center;font-size:13px}
 .jtitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .jchip{flex:none;font-family:ui-monospace,monospace;font-size:10px;font-weight:600;padding:2px 7px;border-radius:99px}
 .jstatus{flex:none;color:${MUTED};font-size:11px;width:90px;text-align:right;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .foot{padding:4px 22px 24px;color:${MUTED};font-size:12px;max-width:1000px;line-height:1.6}
 ${hideCss}
</style></head><body>
 <div class="hdr">
   <h1>Mainline <span style="color:${MUTED};font-weight:400">— portfolio governance, three lenses on one feed</span></h1>
   <p class="sub">Shell prototype · ${projects.length} projects · one dataset → switch lens; toggle layers; filter project. (Built from the live seed.)</p>
 </div>
 <div class="bar">
   <div class="switch">
     <button data-lens="subway" class="active">Subway</button>
     <button data-lens="journal">Journal</button>
     <button data-lens="network">Network</button>
   </div>
   <div class="sep"></div>
   <div class="ctrl">${layerToggles}</div>
   <div class="sep"></div>
   <div class="ctrl"><span>Project</span><select id="proj-filter">${projOpts}</select></div>
   <div class="sep"></div>
   <div class="ctrl pill">Zoom: Week · <b style="color:${INK2}">Month</b> · Quarter &nbsp;|&nbsp; Trace: click a Network node</div>
 </div>
 <div class="legend">${legendChips}</div>
 <div class="stage">
   <div id="lens-subway"><div class="scroll">${subwaySvg()}</div></div>
   <div id="lens-journal" style="display:none"><div class="scroll">${journalHtml()}</div></div>
   <div id="lens-network" style="display:none"><div class="scroll">${net.svg}</div></div>
 </div>
 <div class="foot"><b>This is the shell:</b> one <code>/api/timeline</code> feed, a view-switcher, and a shared control surface (layer toggles + project filter work now; zoom/focus are stubbed chrome). <b>Subway</b> = swimlanes by type, each project a colored line. <b>Journal</b> = the vertical narrative feed (scales best). <b>Network</b> = dependency/link graph — click any node for Trace (its links light, the rest dims). Hover stations for details. The real build wires this to live data, the inspector, and real task dependencies.</div>
 <script>window.__EDGES__=${net.edges};</script>
 <script>
 (function(){
   var lenses={subway:document.getElementById("lens-subway"),journal:document.getElementById("lens-journal"),network:document.getElementById("lens-network")};
   var tabs=document.querySelectorAll("[data-lens]");
   function show(name){for(var k in lenses){lenses[k].style.display=(k===name?"block":"none");}tabs.forEach(function(t){t.classList.toggle("active",t.getAttribute("data-lens")===name);});}
   tabs.forEach(function(t){t.addEventListener("click",function(){show(t.getAttribute("data-lens"));});});
   document.querySelectorAll("[data-layer]").forEach(function(cb){cb.addEventListener("change",function(){document.body.classList.toggle("hide-"+cb.getAttribute("data-layer"),!cb.checked);});});
   var sel=document.getElementById("proj-filter");
   sel.addEventListener("change",function(){var v=sel.value;document.querySelectorAll("[data-proj]").forEach(function(el){el.style.opacity=(!v||el.getAttribute("data-proj")===v)?"":"0.1";});});
   var EDGES=window.__EDGES__||[];var net=document.getElementById("net-svg");
   if(net){net.addEventListener("click",function(e){
     var node=e.target.closest&&e.target.closest("[data-node]");
     net.querySelectorAll("[data-node].hl").forEach(function(n){n.classList.remove("hl");});
     if(!node){net.classList.remove("tracing");return;}
     var id=node.getAttribute("data-node");var nb={};nb[id]=1;
     EDGES.forEach(function(ed){if(ed[0]===id)nb[ed[1]]=1;if(ed[1]===id)nb[ed[0]]=1;});
     net.classList.add("tracing");
     net.querySelectorAll("[data-node]").forEach(function(n){if(nb[n.getAttribute("data-node")])n.classList.add("hl");});
   });}
 })();
 </script>
</body></html>`;

const out=path.join(here,"mainline-shell.html");
writeFileSync(out,html,"utf8");
console.log("wrote",out,"·",(html.length/1024).toFixed(0)+"kb · nodes/edges in network:",net.edges.length);
