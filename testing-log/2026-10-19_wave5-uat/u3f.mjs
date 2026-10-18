import { open, BASE } from "./ui.mjs";
for (const [w,h,tag] of [[390,844,"m"],[1280,800,"d"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/approvals",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(9000);
  await shot(`U3-${tag}-approvals`);
  const t = await text(); console.log(tag, t.split("\n").filter(l=>/sprint|resource|allocation|clash|program|delet|removes|W5/i.test(l)).slice(0,40).join(" | "));
  await page.evaluate(()=>window.scrollTo(0,0));
  await browser.close();
}
