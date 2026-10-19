import { open, BASE } from "./ui.mjs";
const { browser, page, shot, text } = await open("admin", 390, 844);
await page.goto(BASE+"/tokens",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
await page.getByText("Mint scoped PAT").first().click(); await page.waitForTimeout(1500);
await shot("U7-m-2-tokens-form");
const inputs = await page.evaluate(()=>[...document.querySelectorAll("input")].map(i=>i.type+":"+(i.value||i.name||i.placeholder)).join(" | "));
console.log(inputs.slice(0,1500));
const t = await text(); console.log(["program:delete:request","sprint:delete:request","resource:delete:request","allocation:delete:request","clash:delete:request","document:write","change:write","Program","Sprint"].map(s=>s+"="+t.includes(s)).join(" "));
await browser.close();
