import { open, BASE } from "./ui.mjs"; import { rec, sql } from "./h.mjs";
const [w,h,tag] = process.argv[2]==="d" ? [1280,800,"1280"] : [390,844,"390"];
const { browser, page, shot, text } = await open("manager", w, h);
await page.goto(BASE + "/projects", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(12000);
for (const [variant, start] of [["nodates",null],["startonly","2026-11-02"]]) {
  await page.goto(BASE + "/projects", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(6000);
  const nb = page.getByRole("button", { name: /new project/i }).locator("visible=true").first();
  await nb.click(); await page.waitForTimeout(2000);
  const name = `UAT035 ${tag} ${variant} ${Date.now()%100000}`;
  await page.getByLabel("Project name").first().fill(name);
  if (start) await page.getByLabel(/^Start Date/).first().fill(start);
  await shot(`035-${tag}-${variant}-1-form`);
  const resp = page.waitForResponse((r)=>r.url().includes("/api/projects")&&r.request().method()==="POST",{timeout:20000}).catch(()=>null);
  await page.getByRole("button", { name: /Create Project/ }).locator("visible=true").last().click();
  const r = await resp; await page.waitForTimeout(8000);
  const t = await text();
  rec(`035-${tag}-${variant}`, { post: r?.status(), url: page.url(), errorToast: /invalid|error|failed/i.test(t) ? (t.match(/[^\n]*(invalid|error|failed)[^\n]*/i)||[])[0] : null, milestones: sql(`select count(*) from milestones m join projects p on p.id=m.project_id where p.name='${name}'`), dates: sql(`select coalesce(start_date::text,'null')||'/'||coalesce(target_date::text,'null') from projects where name='${name}'`) });
  await shot(`035-${tag}-${variant}-2-after`);
}
await browser.close();
