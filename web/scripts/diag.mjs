// Diagnose the console data path: grants, RLS policies, and RLS-visible rows for the admin user.
import pg from "pg";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const pw = env.SUPABASE_DB_PASSWORD;
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const c = new pg.Client({
  connectionString: env.DB_URL || `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`,
  ssl: { rejectUnauthorized: false },
});
await c.connect();

const profiles = (await c.query("select id, workspace_id, role, email from profiles")).rows;
console.log("profiles:", profiles);

const totals = (await c.query("select (select count(*) from projects)::int p, (select count(*) from tasks)::int t, (select count(*) from risks)::int r")).rows[0];
console.log("raw totals (as postgres, no RLS):", totals);

const grants = (await c.query(`select
  has_table_privilege('authenticated','projects','SELECT') auth_sel_projects,
  has_table_privilege('authenticated','projects','INSERT') auth_ins_projects,
  has_table_privilege('anon','projects','SELECT') anon_sel_projects`)).rows[0];
console.log("grants:", grants);

const pols = (await c.query("select tablename, count(*)::int n from pg_policies where schemaname='public' group by 1 order by 1")).rows;
console.log("rls policies per table:", pols.map(p => `${p.tablename}:${p.n}`).join(", "));

// Simulate the logged-in admin user (RLS + authenticated role)
const uid = profiles[0]?.id;
if (uid) {
  await c.query("begin");
  await c.query("select set_config('role','authenticated',true)");
  await c.query(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: "authenticated" })}', true)`);
  try {
    const ws = (await c.query("select nopm_current_workspace() as ws, nopm_current_role() as role")).rows[0];
    console.log("as-user nopm_current_workspace():", ws);
    const vis = (await c.query("select count(*)::int n from projects")).rows[0].n;
    console.log("RLS-visible projects for admin user:", vis);
  } catch (e) {
    console.log("RLS SIMULATION ERROR:", e.message);
  }
  await c.query("rollback");
}
await c.end();
