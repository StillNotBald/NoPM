import { open, BASE } from "./ui.mjs";
import { call, rec } from "./h.mjs";
let r = await call("admin","GET","/api/workspace-settings"); rec("U8-get",{status:r.status,hasRetro:r.text.includes("emergency_retro"),full:JSON.stringify(r.json).includes("emergency_retro_hours")});
console.log(JSON.stringify(r.json).slice(0,600));
const before = JSON.stringify(r.json?.data);
r = await call("admin","PATCH","/api/workspace-settings",{emergency_retro_hours:48}); rec("U8-patch",{status:r.status,text:r.text.slice(0,300)});
r = await call("admin","GET","/api/workspace-settings"); rec("U8-after",{same:JSON.stringify(r.json?.data)===before,hasRetro:r.text.includes("emergency_retro")});
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/settings",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(9000);
  const t = await text(); console.log(tag,"retro:",/retro/i.test(t),"| emergency lines:", t.split("\n").filter(l=>/emergenc/i.test(l)).join(" | ").slice(0,500));
  const el = page.getByText(/Emergency/).first(); if (await el.count()) await el.scrollIntoViewIfNeeded();
  await shot(`U8-${tag}-settings`); await browser.close();
}
