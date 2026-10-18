import { open, BASE } from "./ui.mjs"; import { rec } from "./h.mjs";
{ const { browser, page, shot, text } = await open("manager", 390, 844);
  for (const [k,title] of [["CR-028","T1 retest emergency decide"],["CR-029","T3 retest emergency 390"],["CR-030","T3 retest emergency 1280"]]) {
    await page.goto(BASE+"/change-control?status=all",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(10000);
    await page.getByText(title,{exact:true}).locator("visible=true").first().click(); await page.waitForTimeout(3000);
    const t = await text();
    rec(`037-390b-${k}`,{detail:t.includes(k)&&/Decision rationale/i.test(t),ownerDecision:/owner decision/i.test(t),q1:/\bQ1\b/.test(t)});
    await page.mouse.wheel(0,3000); await page.waitForTimeout(500); await shot(`037-390-${k}-detail`);
  }
  await browser.close(); }
for (const [w,h,tag] of [[390,844,"390"],[1280,800,"1280"]]) {
  const { browser, page, shot, text } = await open("admin", w, h);
  await page.goto(BASE+"/settings",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(12000);
  let t = await text(); let i = t.search(/High risk/);
  rec(`038-${tag}`,{around:t.slice(Math.max(0,i-50),i+450), mentionsExpense:/expense/i.test(t.slice(i,i+450))});
  const el = page.getByText(/High risk/).locator("visible=true").first(); await el.scrollIntoViewIfNeeded().catch(()=>{}); await shot(`038-${tag}-approval-policy`);
  await page.goto(BASE+"/integrations",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(12000);
  t = await text(); const gi = t.indexOf("GitHub");
  rec(`039-${tag}`,{intro:(t.match(/[^\n]*deployment[^\n]*/gi)||[]), stale:/successful deployment completes/i.test(t)});
  await page.getByText(/deployment/i).locator("visible=true").first().scrollIntoViewIfNeeded().catch(()=>{}); await shot(`039-${tag}-github-card`);
  await browser.close(); }
