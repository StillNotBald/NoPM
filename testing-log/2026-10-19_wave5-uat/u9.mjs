import { open, BASE } from "./ui.mjs";
import { call, rec, sql } from "./h.mjs";
const pid="21271166-3cce-4d9b-99d4-59d6417008c3"; const T=Date.now();
let r = await call("manager","POST",`/api/projects/${pid}/change-requests`,{title:"W5UAT emergency "+T,category:"scope",priority:"high",is_emergency:true,description:"w5 uat"}); rec("U9-raise",{status:r.status,text:r.text.slice(0,500)});
const id=r.json?.data?.id; console.log(sql(`select status,tier,is_emergency,decided_at from change_requests where id='${id}'`)); console.log(sql(`select action from audit_log where target_id='${id}' order by created_at`));
r = await call("manager","POST",`/api/projects/${pid}/change-requests`,{title:"W5UAT normal "+T,category:"scope",priority:"low"}); rec("U9-normal",{status:r.status});
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("manager", w, h);
  await page.goto(BASE+"/changes",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(9000);
  const t = await text(); console.log(tag, "emergency badge:", /Emergency/i.test(t), t.split("\n").filter(l=>/W5UAT emergency/.test(l)).slice(0,1));
  await shot(`U9-${tag}-changes`);
  await page.goto(BASE+"/change-control",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000); await shot(`U10-${tag}-change-control`);
  const t2 = await text(); console.log(tag,"cc:", t2.slice(0,300).replace(/\n/g," | "));
  await browser.close();
}
