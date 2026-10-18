import { open, BASE } from "./ui.mjs";
const { browser, page, shot, text } = await open("manager", 390, 844);
await page.goto(BASE+"/projects/21271166-3cce-4d9b-99d4-59d6417008c3",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
await page.getByRole("tab",{name:"Activity"}).click(); await page.waitForTimeout(2500);
await page.getByRole("button",{name:"+ Add task"}).first().click(); await page.waitForTimeout(1000);
await page.keyboard.type("W5UAT dbg task"); await shot("U5-dbg1");
console.log(await page.evaluate(()=>[...document.querySelectorAll("button")].filter(b=>b.offsetParent).map(b=>b.innerText.trim()||b.getAttribute("aria-label")).filter(Boolean).slice(-20).join(" | ")));
await browser.close();
