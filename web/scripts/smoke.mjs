// NoPM — API smoke test against a running dev server + live DB.
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const BASE = "http://localhost:3000";
const MAKER = env.NOPM_MAKER_TOKEN;
const CHECKER = env.NOPM_CHECKER_TOKEN;
const h = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
};

// wait for the dev server (compiles on first hit)
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

let r = await fetch(BASE + "/api/health"); let j = await r.json().catch(() => ({}));
check("health 200 + {data:{status:ok}}", r.status === 200 && j.data?.status === "ok");

r = await fetch(BASE + "/api/projects");
check("no-auth list -> 401", r.status === 401);

r = await fetch(BASE + "/api/projects", { headers: h(MAKER) });
j = await r.json().catch(() => ({}));
check("maker list -> 200 array", r.status === 200 && Array.isArray(j.data), JSON.stringify(j).slice(0, 140));
const before = Array.isArray(j.data) ? j.data.length : -1;

r = await fetch(BASE + "/api/projects", {
  method: "POST", headers: h(MAKER),
  body: JSON.stringify({ code: "NBC-H", name: "Network Modernisation", program: "NBC-H Merger", rag_status: "amber" }),
});
j = await r.json().catch(() => ({}));
check("maker create -> 201 (implies audit write OK)", r.status === 201 && !!j.data?.id, `${r.status} ${JSON.stringify(j).slice(0, 160)}`);
const pid = j.data?.id;

r = await fetch(BASE + "/api/projects", { headers: h(MAKER) });
j = await r.json().catch(() => ({}));
check("list shows +1", Array.isArray(j.data) && j.data.length === before + 1);

r = await fetch(BASE + "/api/projects", {
  method: "POST", headers: h(CHECKER), body: JSON.stringify({ code: "X", name: "Should Fail" }),
});
check("checker lacks project:write -> 403", r.status === 403, `got ${r.status}`);

if (pid) {
  r = await fetch(`${BASE}/api/projects/${pid}/tasks`, {
    method: "POST", headers: h(MAKER), body: JSON.stringify({ name: "Cutover dry-run" }),
  });
  j = await r.json().catch(() => ({}));
  check("create task -> 201", r.status === 201 && !!j.data?.id, `${r.status} ${JSON.stringify(j).slice(0, 160)}`);
  const tid = j.data?.id;
  if (tid) {
    r = await fetch(`${BASE}/api/tasks/${tid}`, {
      method: "DELETE", headers: h(MAKER), body: JSON.stringify({ reason: "superseded" }),
    });
    j = await r.json().catch(() => ({}));
    check("task DELETE (maker) -> 202 pending request", r.status === 202, `${r.status} ${JSON.stringify(j).slice(0, 140)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
