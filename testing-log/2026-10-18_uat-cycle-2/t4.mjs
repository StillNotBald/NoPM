import { open, api, BASE } from "./lib.mjs";
const s = await open("admin", 390, 844); const p = s.page;
p.on("response", r=>{ if(r.status()>=400) console.log("HTTP", r.status(), r.url().replace(BASE,"").slice(0,100)); });
await p.goto(BASE + "/approvals", { waitUntil: "load" }); await p.waitForTimeout(15000);
console.log((await s.text()).slice(0,300)); await s.shot("probe-adm");
console.log(JSON.stringify(await api(p,"GET","/api/me")));
await s.browser.close();
