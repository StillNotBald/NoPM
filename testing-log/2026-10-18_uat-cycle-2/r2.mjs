import { open, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m";
const s = await open("manager", w, w>600?800:844); const p = s.page;
await p.goto(BASE + "/documents", { waitUntil: "load" }); await p.waitForTimeout(4000);
await s.shot(`r2-${tag}-1-list`);
await p.getByText("Evidence for CR-009").locator("visible=true").first().click(); await p.waitForTimeout(3000);
await s.shot(`r2-${tag}-2-viewer`);
const t = await s.text(); const i = t.indexOf("Evidence for CR-009"); console.log(t.slice(Math.max(0,i-200), i+1200));
await s.browser.close();
