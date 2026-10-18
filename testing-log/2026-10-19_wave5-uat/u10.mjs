import { open, BASE } from "./ui.mjs";
import { call, rec } from "./h.mjs";
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/reports",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(9000);
  const t = await text(); console.log(tag, page.url(), t.slice(0,350).replace(/\n/g," | "), "hscroll:", await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  await shot(`U10-${tag}-weekly-report`);
  await page.goto(BASE+"/change-control",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(7000);
  const b = page.getByRole("button",{name:/audit pack/i}).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(1200); await shot(`U2-${tag}-audit-pack-panel`); }
  await browser.close();
}
let r = await call("admin","GET","/api/reports/weekly"); rec("U10-weekly-api",{status:r.status,text:r.text.slice(0,200)});
