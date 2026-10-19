import { readFileSync } from "node:fs";
function parse(t){const rows=[];let r=[],f="",q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){f+='"';i++}else q=false}else f+=c}else if(c=='"')q=true;else if(c==","){r.push(f);f=""}else if(c=="\n"){r.push(f.replace(/\r$/,""));rows.push(r);r=[];f=""}else f+=c}if(f||r.length){r.push(f);rows.push(r)}return rows}
const rows=parse(readFileSync("auditpack.csv","utf8"));const h=rows[0];const ix=Object.fromEntries(h.map((x,i)=>[x,i]));
console.log("has emergency col:",h.includes("emergency"),"| is_emergency:",h.includes("is_emergency"),"| retro_overdue:",h.includes("retro_overdue"));
const cr=rows.filter(r=>r[0]=="change_requests");
const vals=(c)=>[...new Set(cr.map(r=>r[ix[c]]))];
console.log("rows",cr.length,"is_emergency values",vals("is_emergency"),"retro_overdue values",vals("retro_overdue"),"tier values",vals("tier"));
for(const ref of ["CR-024","CR-025","CR-028","CR-013","CR-017","CR-022","CR-002"]){const r=cr.find(r=>r[ix.ref]==ref);if(r)console.log(ref,"tier",r[ix.tier],"is_emergency",JSON.stringify(r[ix.is_emergency]),"retro_overdue",JSON.stringify(r[ix.retro_overdue]),"retro_outcome",r[ix.retro_outcome],"retro_due_at",r[ix.retro_due_at])}
