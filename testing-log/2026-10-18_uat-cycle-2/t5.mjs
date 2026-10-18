import { open, BASE } from "./lib.mjs";
const s = await open("manager", 1280, 800); const p = s.page;
await p.goto(BASE + "/budget", { waitUntil: "load" }); await p.waitForTimeout(6000);
console.log(await p.getByRole("button",{name:/delet/i}).evaluateAll(b=>b.map(x=>x.getAttribute("aria-label")+"|"+x.innerText+"|"+(x.closest("tr,li")?.innerText||"").replace(/\n/g," ").slice(0,100))).then(a=>a.join("\n")));
await s.browser.close();
