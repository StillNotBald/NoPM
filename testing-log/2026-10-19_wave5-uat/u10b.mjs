import { open, BASE } from "./ui.mjs";
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/api/reports/weekly",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(2500);
  const t = await text(); console.log(tag, t.slice(0,250).replace(/\n/g," | "), "hscroll:", await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  await page.screenshot({path:`screens/U10-${tag}-weekly-report.png`}); 
  await page.goto(BASE+"/change-control",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(6000);
  const b = page.getByText("Audit pack").first(); await b.click(); await page.waitForTimeout(1200); await shot(`U2-${tag}-audit-pack-panel`);
  await browser.close();
}
