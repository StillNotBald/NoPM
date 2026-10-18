import { open, BASE } from "./lib.mjs";
import { pickCard } from "./pick.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m"; const role = process.argv[3]; const key=process.argv[4]; const out=process.argv[5]; const confirm = process.argv[6] !== "noconfirm";
const s = await open(role, w, w>600?800:844); const p = s.page;
const resp=[]; p.on("response", async r=>{ if(r.request().method()==="POST" && /approv|decid|deletion/.test(r.url())){ let t=""; try{t=(await r.text()).slice(0,400)}catch{}; resp.push("POST "+r.url().replace(BASE,"")+" "+r.status()+" "+t);} });
await p.goto(BASE + "/approvals", { waitUntil: "load" }); await p.getByText(/pending deletion request/i).first().waitFor({timeout:60000}); await p.waitForTimeout(2500);
let b = null; for (let i=0;i<4 && !b;i++){ try { await p.waitForLoadState("load"); await p.waitForTimeout(2500); b = await pickCard(p, key); } catch (e) { console.log("retry", i); } }
if (!b) { console.log("NO MATCHING CARD WITH APPROVE BUTTON for", key); await s.shot(`${out}-${tag}-4-nocard-${role}`); console.log((await s.text()).slice(0,1500)); await s.browser.close(); process.exit(0); }
await b.scrollIntoViewIfNeeded(); await b.click(); await p.waitForTimeout(1200);
await s.shot(`${out}-${tag}-5-confirm-${role}`);
console.log("confirm prompt visible:", await p.getByText(/Confirm: approve/i).filter({visible:true}).count());
if (confirm) { await p.getByRole("button", {name:/^confirm approve/i}).filter({visible:true}).first().click(); await p.waitForTimeout(3500); await s.shot(`${out}-${tag}-6-result-${role}`); }
console.log(resp.join("\n"));
await s.browser.close();
