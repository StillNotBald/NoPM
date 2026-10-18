import { open, BASE } from "./lib.mjs";
const s = await open("manager", 1280, 800); const p = s.page;
await p.goto(BASE + "/projects", { waitUntil: "load" }); await p.waitForTimeout(8000);
await p.getByRole("button", { name: /New Project/i }).first().click(); await p.waitForTimeout(2500);
console.log("form:", await p.getByText("Start Date").count());
await s.shot("r1-d-1-newform");
await s.browser.close();
