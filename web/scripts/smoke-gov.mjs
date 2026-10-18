// NoPM — governance hero-path smoke test: the full four-eyes loop + audit trail.
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const BASE = "http://localhost:3000";
const MAKER = env.NOPM_MAKER_TOKEN, CHECKER = env.NOPM_CHECKER_TOKEN;
const h = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const body = (r) => r.json().catch(() => ({}));

let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("PASS", n)) : (fail++, console.log("FAIL", n, x)));

// wait for /api/me (built in Wave B) to confirm the server has the governance routes
for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/api/me", { headers: h(MAKER) }); if (r.status !== 404) break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

let r = await fetch(BASE + "/api/me", { headers: h(MAKER) }); let j = await body(r);
check("GET /api/me (maker) -> token actor", r.status === 200 && j.data?.type === "token", `${r.status} ${JSON.stringify(j).slice(0,120)}`);

r = await fetch(BASE + "/api/projects", { method: "POST", headers: h(MAKER), body: JSON.stringify({ name: "Four-Eyes Demo", code: "DEMO" }) });
const pid = (await body(r)).data?.id;
r = await fetch(`${BASE}/api/projects/${pid}/tasks`, { method: "POST", headers: h(MAKER), body: JSON.stringify({ name: "Decommission legacy node" }) });
const tid = (await body(r)).data?.id;
check("setup: project + task created", !!pid && !!tid);

r = await fetch(`${BASE}/api/tasks/${tid}`, { method: "DELETE", headers: h(MAKER), body: JSON.stringify({ reason: "duplicate" }) });
j = await body(r);
const reqId = j.data?.id;
check("maker requests delete -> 202 pending", r.status === 202 && !!reqId, `${r.status}`);

r = await fetch(`${BASE}/api/deletion-requests/${reqId}/approve`, { method: "POST", headers: h(MAKER) });
check("maker approves own request -> DENIED (403)", r.status === 403, `got ${r.status}`);

r = await fetch(`${BASE}/api/tasks/${tid}`, { headers: h(MAKER) });
check("task still alive after denied self-approval", r.status === 200, `got ${r.status}`);

r = await fetch(`${BASE}/api/deletion-requests/${reqId}/approve`, { method: "POST", headers: h(CHECKER) });
j = await body(r);
check("checker approves -> committed (200)", r.status === 200, `${r.status} ${JSON.stringify(j).slice(0,120)}`);

r = await fetch(`${BASE}/api/tasks/${tid}`, { headers: h(MAKER) });
check("task now gone -> 404", r.status === 404, `got ${r.status}`);

r = await fetch(`${BASE}/api/audit?limit=50`, { headers: h(MAKER) });
j = await body(r);
const actions = (j.data || []).map((a) => a.action);
check("audit shows task.delete in trail", actions.includes("task.delete"), actions.slice(0, 8).join(","));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
