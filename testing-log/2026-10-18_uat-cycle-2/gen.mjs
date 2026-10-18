// usage: node gen.mjs role width path shotname [clickText] ; prints text after hydration
import { open, BASE } from "./lib.mjs";
const [role, w0, path, name, click] = process.argv.slice(2); const w=+w0;
const s = await open(role, w, w>600?800:844); const p = s.page;
await p.goto(BASE + path, { waitUntil: "load" });
await p.waitForFunction(()=>/^(DM|JH|UM)$/m.test(document.body.innerText),null,{timeout:60000}).catch(()=>{}); await p.waitForTimeout(3000);
if (process.env.WAITFOR) await p.getByText(process.env.WAITFOR).first().waitFor({timeout:60000}).catch(()=>console.log("WAITFOR timeout")); await p.waitForTimeout(1500);
if (click) { await p.getByText(click).locator("visible=true").first().click(); await p.waitForTimeout(1500); }
if (process.env.WAITFOR) await p.getByText(process.env.WAITFOR).first().scrollIntoViewIfNeeded().catch(()=>{}); await p.waitForTimeout(500);
await s.shot(name);
console.log((await s.text()));
await s.browser.close();
