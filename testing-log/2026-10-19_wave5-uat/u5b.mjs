import { open, BASE } from "./ui.mjs";
const T = Date.now();
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("manager", w, h);
  await page.goto(BASE+"/projects/21271166-3cce-4d9b-99d4-59d6417008c3",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(8000);
  await page.getByRole("tab",{name:"Activity"}).click(); await page.waitForTimeout(2500);
  await page.getByRole("button",{name:"Task",exact:true}).first().click(); await page.waitForTimeout(1500);
  const name = `W5UAT blocked ${tag} ${T}`;
  await page.getByPlaceholder("Task name").fill(name);
  const rs = page.getByPlaceholder("Why is this blocked? (optional)"); console.log(tag,"reason input:", await rs.count());
  const lbl = page.getByLabel("ETA"); console.log("eta input:", await lbl.count());
  await rs.scrollIntoViewIfNeeded(); await shot(`U5-${tag}-1-form`);
  await rs.fill("Waiting on vendor API keys"); await lbl.fill("2026-10-30");
  const ov = await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth); console.log("hscroll",ov);
  await shot(`U5-${tag}-2-filled`);
  const save = page.getByRole("button",{name:/^(save|create|add task|create task|save task)$/i}).last(); console.log("save btn", await save.count());
  await save.click(); await page.waitForTimeout(3500);
  await shot(`U5-${tag}-3-saved`);
  const t = await text(); console.log(tag, t.split("\n").filter(l=>/Blocked|ETA/.test(l)).join(" | "));
  await browser.close();
}
