import { open, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m";
const s = await open("admin", w, w>600?800:844); const p = s.page;
await p.goto(BASE + "/change-control", { waitUntil: "load" });
await p.waitForFunction(()=>/^JH$/m.test(document.body.innerText),null,{timeout:60000}).catch(()=>{}); await p.waitForTimeout(4000);
const csv=p.getByText(/^download csv$/i).locator("visible=true"); for(let i=0;i<4 && !(await csv.count());i++){ await p.getByRole("button",{name:/audit pack/i}).filter({visible:true}).first().click(); await p.waitForTimeout(2500); }
const [dl] = await Promise.all([p.waitForEvent("download",{timeout:60000}), p.getByText(/^download csv$/i).locator("visible=true").first().click()]);
const f = `dl/auditpack-${tag}-${dl.suggestedFilename()}`; await dl.saveAs(f); console.log("saved", f);
await p.waitForTimeout(1500); await s.shot(`r13-${tag}-2-downloaded`);
await s.browser.close();
