import { open, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w>600?"d":"m";
const s = await open("manager", w, w>600?800:844); const p = s.page;
for (const [pg,name] of [["approvals","approvals"],["review","review"],["trust","trust"]]) {
  await p.goto(BASE + "/"+pg, { waitUntil: "load" }); await p.waitForTimeout(4500);
  await s.shot(`r6-${tag}-5-${name}`);
  const x = await s.text();
  console.log(`== ${pg}: mentions CR-024/retest phone/emergency retest:`, /CR-024|UAT-A emergency retest/.test(x), "| emergency_commit:", /emergency_commit/.test(x));
}
await s.browser.close();
