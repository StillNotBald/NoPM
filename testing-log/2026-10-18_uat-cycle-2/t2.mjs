import { open, BASE } from "./lib.mjs";
const s = await open("manager", 1280, 800); const p = s.page; let loads=0; p.on("load",()=>loads++);
const t0=Date.now();
await p.goto(BASE + "/projects", { waitUntil: "load" });
for (let i=0;i<8;i++){ await p.waitForTimeout(4000); let h=-2; try{ h = await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/New Project/.test(x.innerText)); return b? Object.keys(b).length:-1}); }catch{} console.log(((Date.now()-t0)/1000).toFixed(0)+"s hyd", h, "loads", loads); }
await s.browser.close();
