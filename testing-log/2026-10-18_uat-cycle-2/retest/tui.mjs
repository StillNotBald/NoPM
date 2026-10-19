import { open, BASE } from "./ui.mjs"; import { rec } from "./h.mjs";
const go = async (page, p) => { await page.goto(BASE + p, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(14000); };
// T5 + T9 as admin desktop
{ const { browser, page, shot, text } = await open("admin", 1280, 800);
  await go(page, "/settings"); 
  let t = await text();
  const i = t.indexOf("Emergency");
  rec("t5-ui", { sentence: t.includes("Commits when raised. No approval. Flagged everywhere."), retroField: /retro/i.test(t), around: t.slice(Math.max(0,i-100), i+250) });
  const el = page.getByText("Commits when raised. No approval. Flagged everywhere.").first();
  if (await el.count()) await el.scrollIntoViewIfNeeded();
  await shot("t5-1280-approval-policy");
  await go(page, "/integrations"); t = await text();
  const gi = t.indexOf("GitHub");
  const selects = await page.locator("select").evaluateAll((els) => els.map((e) => [...e.options].map((o) => o.text)));
  rec("t9-ui", { completedOption: JSON.stringify(selects).toLowerCase().includes("complet"), selectCount: selects.length, optionSets: selects.slice(-5), helper: (t.match(/[^\n]*human action[^\n]*/i)||[null])[0], hasCompletedWord: /Completed/.test(t) });
  await page.locator("select").last().scrollIntoViewIfNeeded().catch(()=>{});
  await shot("t9-1280-github-card");
  await browser.close(); }
// T11
for (const [role, tag] of [["member","member"],["admin","admin"],["manager","manager"]]) {
  const { browser, page, shot } = await open(role, 390, 844);
  await go(page, "/my-work");
  const labels = await page.locator("[aria-label*='items'], [aria-label*='item ']").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const txt = await page.evaluate(() => [...document.querySelectorAll("*")].filter((e) => /awaiting your decision|in review/.test(e.textContent||"") && e.children.length===0).map((e)=>e.textContent.trim()).slice(0,6));
  rec(`t11-${tag}`, { labels: [...new Set(labels)], srText: txt });
  await shot(`t11-390-${tag}`);
  await browser.close(); }
