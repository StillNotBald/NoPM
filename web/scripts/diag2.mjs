// Diagnose: does a REAL signed-in user JWT see the data via RLS (Supabase REST)?
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const signin = await (await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anon, "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@stillnotbald.com", password: "NoPMdemo!2026" }),
})).json();
console.log("signin:", signin.access_token ? "OK — got access_token" : JSON.stringify(signin).slice(0, 200));
const at = signin.access_token;
if (!at) process.exit(1);

// decode JWT payload
const payload = JSON.parse(Buffer.from(at.split(".")[1], "base64").toString());
console.log("jwt sub:", payload.sub, "| role:", payload.role, "| has app metadata workspace?", payload.user_metadata ?? "(none)");

// query projects + tasks as this user via PostgREST (RLS)
for (const tbl of ["projects", "tasks", "risks", "milestones"]) {
  const r = await fetch(`${url}/rest/v1/${tbl}?select=id&limit=100`, {
    headers: { apikey: anon, Authorization: `Bearer ${at}` },
  });
  const j = await r.json();
  console.log(`REST ${tbl}: status ${r.status} -> ${Array.isArray(j) ? j.length + " rows" : JSON.stringify(j).slice(0, 160)}`);
}

// can the user INSERT a project via PostgREST (RLS write)?
const ins = await fetch(`${url}/rest/v1/projects`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${at}`, "content-type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ name: "diag insert test", workspace_id: env.NOPM_WORKSPACE_ID }),
});
const insj = await ins.json();
console.log("REST insert project: status", ins.status, "->", Array.isArray(insj) ? "OK created" : JSON.stringify(insj).slice(0, 200));
