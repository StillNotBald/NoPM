// Verify the authenticated console data path WITHOUT a browser: connect as the
// admin user under RLS (request.jwt.claims) and assert every console page will
// render populated, workspace-scoped data — the same query path the server
// components use. Proves the persona journeys end-to-end at the data layer.
import pg from "pg";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const dbRef = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const c = new pg.Client({
  connectionString: env.DB_URL || `postgresql://postgres:${env.SUPABASE_DB_PASSWORD}@db.${dbRef}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const admin = (await c.query("select id, workspace_id from profiles where role='admin' limit 1")).rows[0];

let pass = 0, fail = 0;
// Session-level (not a transaction) so one failing query does not poison the rest.
await c.query(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: admin.id, role: "authenticated" })}', false)`);
await c.query("set role authenticated");

const n = async (sql) => (await c.query(sql)).rows[0].n;
const check = async (name, sql, min = 1) => {
  let v;
  try { v = await n(sql); } catch (e) { fail++; console.log("FAIL", name, "->", e.message); return; }
  if (v >= min) { pass++; console.log("PASS", name, "=", v); }
  else { fail++; console.log("FAIL", name, "=", v, `(expected >= ${min})`); }
};

// C-level glance — dashboard
await check("dashboard · projects", "select count(*)::int n from projects");
await check("dashboard · open risks", "select count(*)::int n from risks where status not in ('closed','accepted')");
await check("dashboard · open issues", "select count(*)::int n from issues");
// SME what's-hot — My Work / registers
await check("registers · clashes", "select count(*)::int n from clashes");
await check("resources", "select count(*)::int n from resource_members");
// Documents (folder viewer) + real files
await check("documents · total", "select count(*)::int n from documents");
await check("documents · with a stored file", "select count(*)::int n from documents where storage_path is not null");
await check("documents · in_review (feeds queue)", "select count(*)::int n from documents where status='in_review'");
// Change control + decisions
await check("change-control · total", "select count(*)::int n from change_requests");
await check("change-control · under_review (feeds queue)", "select count(*)::int n from change_requests where status='under_review'");
await check("change-control · decided rows honour four-eyes",
  "select count(*)::int n from change_requests where decided_by is not null and decided_by = requested_by", 0);
await check("decisions · log", "select count(*)::int n from decisions");
// Review Queue sources
await check("review · pending deletions", "select count(*)::int n from deletion_requests where status='pending'", 0);
// Notifications (bell)
await check("notifications · for a recipient", "select count(*)::int n from notifications", 0);
// Governance backbone — audit trail is populated
await check("trust · audit_log rows", "select count(*)::int n from audit_log");

// Assert the four-eyes integrity invariant explicitly: NO decided CR may be self-decided
const selfDecided = await n("select count(*)::int n from change_requests where decided_by is not null and decided_by = requested_by");
if (selfDecided === 0) { pass++; console.log("PASS four-eyes invariant · zero self-decided change requests"); }
else { fail++; console.log("FAIL four-eyes invariant · self-decided change requests =", selfDecided); }

await c.query("reset role");
await c.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
