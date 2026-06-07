// NoPM — apply SQL migrations to a Postgres DB in order, idempotently.
// Usage:  DB_URL="postgresql://..." node scripts/apply-migrations.mjs
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "supabase", "migrations");

const url = process.env.DB_URL;
if (!url) {
  console.error("Set DB_URL env var to the Postgres connection string.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(
  `create table if not exists _nopm_migrations (name text primary key, applied_at timestamptz default now())`,
);
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
