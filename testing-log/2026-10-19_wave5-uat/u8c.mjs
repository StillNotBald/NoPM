import { open, BASE } from "./ui.mjs";
const { browser, page, shot, text } = await open("admin", 1280, 800);
await page.goto(BASE+"/settings",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(9000);
const t = await text(); const i=t.indexOf("Emergency"); console.log(t.slice(Math.max(0,i-300),i+400));
await browser.close();
