import { open, BASE } from "./lib.mjs";
const s = await open("manager", 390, 844); const p = s.page;
await p.goto(BASE + "/change-control", { waitUntil: "load" }); await p.waitForTimeout(4000);
await p.getByRole("button", { name: /Raise Change Request/i }).first().click(); await p.waitForTimeout(2000);
await s.shot("r6-m-1-form");
console.log(await p.locator("input,select,textarea").evaluateAll(e=>e.map(x=>`${x.tagName}|${x.name}|${x.type}|${x.id}|${x.getAttribute("aria-label")}`)).then(a=>a.join("\n")));
console.log((await s.text()).slice(-1500));
await s.browser.close();
