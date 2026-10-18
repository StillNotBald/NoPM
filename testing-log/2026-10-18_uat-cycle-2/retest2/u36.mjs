import { open, BASE } from "./ui.mjs"; import { rec } from "./h.mjs";
for (const [w,h,tag] of [[390,844,"390"],[1280,800,"1280"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  for (const p of ["approvals","review"]) {
    await page.goto(BASE + "/"+p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(12000);
    const t = await text();
    rec(`036-${tag}-${p}`, { raw: (t.match(/\b(high_risk|normal|routine|strategic|emergency)\b/g)||[]), pretty: [...new Set(t.match(/Routine|Normal|High risk|Emergency|Strategic/g)||[])], len: t.length });
    await shot(`036-${tag}-${p}`);
  }
  await browser.close();
}
