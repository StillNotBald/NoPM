import { open, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m"; const title = process.argv[3];
const s = await open("manager", w, w>600?800:844); const p = s.page;
const resp=[]; p.on("response", async r=>{ if(/\/api\/change-requests/.test(r.url()) && r.request().method()==="POST"){ let t=""; try{t=(await r.text()).slice(0,500)}catch{}; resp.push(r.status()+" "+t);} });
await p.goto(BASE + "/change-control", { waitUntil: "load" }); await p.waitForTimeout(4000);
await p.getByRole("button", { name: /Raise Change Request/i }).first().click(); await p.waitForTimeout(2000);
const panel = p.locator("input[type=text], select").filter({visible:true});
const els = p.locator("input:not([type=checkbox]):not([type=date]):not([type=number]), select").filter({visible:true});
await els.nth(1).fill(title);                 // title
await els.nth(2).selectOption({ label: "S/4HANA Core Rollout — EMEA" });
await p.locator("input[type=checkbox]").check();
await p.waitForTimeout(500);
await s.shot(`r6-${tag}-2-filled`);
await p.getByRole("button", { name: "Raise Change Request" }).last().click(); await p.waitForTimeout(4000);
await s.shot(`r6-${tag}-3-after`);
console.log(resp.join("\n"));
await s.browser.close();
