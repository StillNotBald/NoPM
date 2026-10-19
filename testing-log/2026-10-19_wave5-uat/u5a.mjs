import { open, BASE } from "./ui.mjs";
const { browser, page, shot, text } = await open("manager", 390, 844);
await page.goto(BASE+"/projects/21271166-3cce-4d9b-99d4-59d6417008c3",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
await page.getByRole("tab",{name:"Activity"}).click(); await page.waitForTimeout(3000);
console.log(await page.evaluate(()=>[...document.querySelectorAll("main button")].map(b=>(b.innerText.trim()||b.getAttribute("aria-label"))).filter(Boolean).slice(0,40).join(" | ")));
await shot("U5-m-0-activity");
await browser.close();
