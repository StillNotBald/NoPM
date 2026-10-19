import { open, BASE } from "./ui.mjs"; import { rec, call } from "./h.mjs";
const ids = { "CR-028":"9bf74f2b-699e-4270-baf3-88bd365dde6f","CR-029":"e8e65fe4-faf0-46da-b051-3f2c46d1e99c","CR-030":"ac7f5649-297d-44d4-9398-45b76ce48535" };
for (const [k,id] of Object.entries(ids)) { const r = await call("manager","GET","/api/change-requests/"+id); const s = JSON.stringify(r.json);
  rec("037-api-"+k,{status:r.status,ownerDecision:/owner decision/i.test(s),q1:/\bQ1\b/.test(s),rationale:r.json?.data?.rationale??null,reason:r.json?.data?.reason??null,decision_note:r.json?.data?.decision_note??null}); }
for (const [w,h,tag] of [[390,844,"390"],[1280,800,"1280"]]) {
  const { browser, page, shot, text } = await open("manager", w, h);
  for (const [k,id] of Object.entries(ids)) {
    await page.goto(BASE+"/changes?id="+id,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
    let t = await text();
    if (!t.includes(k)) { await page.goto(BASE+"/changes/"+id,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(6000); t = await text(); }
    rec(`037-${tag}-${k}`,{url:page.url(),hasCR:t.includes(k),ownerDecision:/owner decision/i.test(t),q1:/\bQ1\b/.test(t),len:t.length});
    await shot(`037-${tag}-${k}`);
  }
  await browser.close();
}
