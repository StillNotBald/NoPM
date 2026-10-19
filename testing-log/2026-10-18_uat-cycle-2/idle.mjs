import { open, BASE } from "./lib.mjs";
const s = await open("manager", 1280, 800); const p = s.page; let loads=0; const reqs={};
p.on("load", ()=>loads++);
p.on("request", r=>{ const u=new URL(r.url()); const k=r.method()+" "+u.pathname+(u.search.includes("_rsc")?"?_rsc":""); reqs[k]=(reqs[k]||0)+1; });
await p.goto(BASE + "/projects", { waitUntil: "load" });
await p.waitForTimeout(15000);
console.log("loads",loads);
console.log(Object.entries(reqs).sort((a,b)=>b[1]-a[1]).slice(0,10));
await s.browser.close();
