import { open, BASE } from "./ui.mjs";
const { browser, page } = await open("admin", 1280, 800);
await page.goto(BASE+"/tokens",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
await page.getByText("Mint scoped PAT").first().click(); await page.waitForTimeout(1500);
const labels = await page.evaluate(()=>[...document.querySelectorAll("input[type=checkbox]")].map(i=>(i.closest("label")?.innerText||i.getAttribute("aria-label")||i.parentElement?.innerText||"").replace(/\s+/g," ").trim()));
console.log(labels.length); console.log(labels.filter(l=>/program|sprint|resource|allocation|clash|document|change/i.test(l)).join(" | "));
await page.screenshot({path:"screens/U7-d-2-tokens-form.png",fullPage:true});
await browser.close();
