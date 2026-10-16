// NoPM — apply SQL migrations to a Postgres DB in order, idempotently.
// Usage:  DB_URL="postgresql://..." node scripts/apply-migrations.mjs
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "supabase", "migrations");

let url;
try {
  url = requireEnv(["DB_URL"], loadEnv()).DB_URL;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(
  `create table if not exists _nopm_migrations (name text primary key, applied_at timestamptz default now())`,
);
// The ledger lives in `public`, which PostgREST exposes. Without RLS + a revoke,
// anyone holding the public anon key could read it or INSERT a fake "applied"
// row, making this runner silently SKIP a real migration. RLS on with zero
// policies = postgres / service role only (this runner connects as postgres).
// Both statements are idempotent, so existing installs are fixed on next run.
await client.query(`alter table _nopm_migrations enable row level security`);
await client.query(`revoke all on _nopm_migrations from anon, authenticated`);
const applied = new Set(
  (await client.query("select name from _nopm_migrations")).rows.map((r) => r.name),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  if (applied.has(f)) {
    console.log("skip  ", f);
    continue;
  }
  const sql = await readFile(path.join(migrationsDir, f), "utf8");
  process.stdout.write("apply " + f + " ... ");
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into _nopm_migrations(name) values($1)", [f]);
    await client.query("commit");
    console.log("ok");
  } catch (e) {
    await client.query("rollback");
    console.error("FAILED\n  " + e.message);
    await client.end();
    process.exit(1);
  }
}
await client.end();
console.log("All migrations applied.");
