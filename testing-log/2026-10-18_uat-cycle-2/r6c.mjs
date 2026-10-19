import { open, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m"; const title = process.argv[3];
const s = await open("manager", w, w>600?800:844); const p = s.page;
await p.goto(BASE + "/change-control", { waitUntil: "load" }); await p.waitForTimeout(4000);
await p.getByText(title).locator("visible=true").first().click(); await p.waitForTimeout(2500);
await s.shot(`r6-${tag}-4-detail`);
const x = await s.text(); const i = x.indexOf("Emergency"); console.log(x.slice(Math.max(0,x.lastIndexOf(title)-100)).slice(0,1800));
console.log("buttons:", (await p.getByRole("button").allInnerTexts()).filter(t=>/approve|reject|defer/i.test(t)));
await s.browser.close();
