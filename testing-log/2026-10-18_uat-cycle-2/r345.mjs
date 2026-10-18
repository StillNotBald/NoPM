import { open, api, BASE } from "./lib.mjs";
const w = +process.argv[2]; const tag = w > 600 ? "d" : "m"; const LOCKED = "ed3d04cd-18bd-4ad3-8848-07b876dbd907";
const s = await open("member", w, w > 600 ? 800 : 844); const p = s.page;
const lines = (x) => x.split("\n").filter((l) => /awaiting|in review|your decision/i.test(l));
await p.goto(BASE + "/projects", { waitUntil: "load" }); await p.waitForTimeout(4000);
console.log("R3 tokens export:", JSON.stringify(await api(p, "GET", "/api/export?entity=tokens")));
console.log("R3 control (projects export):", (await api(p, "GET", "/api/export?entity=projects")).status);
await s.shot(`r4-${tag}-1-badge-member`);
console.log("R4 badge:", lines(await s.text()).join(" || "));
await p.goto(BASE + "/change-control", { waitUntil: "load" }); await p.waitForTimeout(4000);
await s.shot(`r4-${tag}-2-changecontrol-member`);
{ const x = await s.text(); console.log("R4 CC:", /awaiting/i.test(x), lines(x).join(" || ")); }
await p.goto(BASE + "/approvals", { waitUntil: "load" }); await p.waitForTimeout(4000);
await s.shot(`r4-${tag}-3-approvals-member`);
{ const x = await s.text(); console.log("R4 appr:", /awaiting/i.test(x), lines(x).join(" || ")); }
await p.goto(BASE + "/projects/" + LOCKED, { waitUntil: "load" }); await p.waitForTimeout(4000);
await s.shot(`r5-${tag}-1-locked-member`);
const tx = await s.text();
console.log("R5 buttons:", (await p.getByRole("button").allInnerTexts()).join("|"), "| unlock text:", /unlock/i.test(tx));
console.log("R5 unlock api:", JSON.stringify(await api(p, "POST", `/api/projects/${LOCKED}/unlock`, { reason: "uat member probe" })));
await s.browser.close();
