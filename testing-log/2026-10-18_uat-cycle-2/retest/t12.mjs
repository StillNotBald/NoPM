import { call, rec, cookieHeader, BASE } from "./h.mjs";
import { open } from "./ui.mjs";
const p = await call("admin","POST","/api/reports/weekly",{});
rec("t12-generate",{status:p.status,body:p.text.slice(0,250)});
const r = await fetch(`${BASE}/api/reports/weekly`,{headers:{cookie:cookieHeader("admin")}});
const html = await r.text(); 
const txt = html.replace(/<style[\s\S]*?<\/style>/g," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ");
const i = txt.indexOf("Emergency changes this week");
rec("t12-get",{status:r.status,section:txt.slice(i,i+400),overdue:/overdue for approval/i.test(txt),retro:/retro/i.test(txt),hasT3:/T3 retest emergency/.test(txt)});
for (const [w,h,tag] of [[390,844,"390"],[1280,800,"1280"]]) {
  const { browser, page, shot } = await open("admin", w, h);
  await page.goto(`${BASE}/api/reports/weekly`,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(2500);
  await shot(`t12-${tag}-weekly`); await browser.close(); }
