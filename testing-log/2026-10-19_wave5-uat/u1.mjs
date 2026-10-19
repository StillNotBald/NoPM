import { open, BASE } from "./ui.mjs";
import { call, rec } from "./h.mjs";
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/trust",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
  console.log(page.url()); const t0 = await text(); console.log(t0.slice(0,900));
  await shot(`U1-${tag}-1-trust`);
  const btn = page.getByRole("button",{name:/verify now/i}).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(6000); await shot(`U1-${tag}-2-after-verify`); console.log("AFTER:", (await text()).slice(0,900)); } else console.log("no verify button");
  await browser.close();
}
const r = await call("admin","GET","/api/audit/verify"); rec("U1-verify",{status:r.status,text:r.text});
