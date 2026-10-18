import { open, BASE } from "./ui.mjs";
const { browser, page, text } = await open("admin", 1280, 800);
for (const p of ["approvals","review"]) { await page.goto(BASE+"/"+p,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(12000); const t=await text(); console.log("==",p); console.log(t.split("\n").filter(l=>/routine|normal|high|emergency|strategic|tier/i.test(l)).join("\n").slice(0,2500)); }
await browser.close();
