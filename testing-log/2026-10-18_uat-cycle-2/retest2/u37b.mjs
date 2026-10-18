import { open, BASE } from "./ui.mjs"; import { rec, call } from "./h.mjs";
const crs = { "CR-028":"9bf74f2b-699e-4270-baf3-88bd365dde6f","CR-029":"e8e65fe4-faf0-46da-b051-3f2c46d1e99c","CR-030":"ac7f5649-297d-44d4-9398-45b76ce48535" };
for (const [k,id] of Object.entries(crs)) { const r = await call("manager","GET","/api/change-requests/"+id); const s = JSON.stringify(r.json);
  rec("037-api-"+k,{status:r.status,ownerDecision:/owner decision/i.test(s),q1:/\bQ1\b/.test(s),decision_rationale:r.json?.data?.decision_rationale}); }
for (const [w,h,tag] of [[390,844,"390"],[1280,800,"1280"]]) {
  const { browser, page, shot, text } = await open("manager", w, h);
  for (const k of Object.keys(crs)) {
    await page.goto(BASE+"/change-control?status=all",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(10000);
    const row = page.getByText(k, {exact:false}).locator("visible=true").first();
    const found = await row.count(); if (found) { await row.click(); await page.waitForTimeout(3000); }
    const t = await text();
    rec(`037-${tag}-${k}`,{clicked:!!found,detailShown:/Emergency/.test(t),ownerDecision:/owner decision/i.test(t),q1:/\bQ1\b/.test(t),line:(t.match(/[^\n]*(no approval required|flagged)[^\n]*/i)||[])[0]});
    await shot(`037-${tag}-${k}`);
  }
  await browser.close();
}
