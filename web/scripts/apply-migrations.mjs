// NoPM — apply SQL migrations to a Postgres DB in order, idempotently.
//
// Usage:  DB_URL="postgresql://..." node scripts/apply-migrations.mjs [--atomic] [--dry-run]
//         node scripts/migrate.mjs [flags]     (same flags; migrate.mjs derives DB_URL, then delegates here)
//         npm run migrate -- [flags]
//
//   (no flag)  Default, unchanged: one transaction PER FILE, the ledger row written inside the same
//              transaction as the file. The first failure stops the run; files already applied stay applied.
//   --atomic   ALL pending files in ONE transaction, all-or-nothing, with lock_timeout 15s and
//              statement_timeout 300s. Use it for a release whose files depend on each other (the
//              lark wave: 0045 drops the old deletion-commit RPCs, 0046 adds the audit columns their
//              replacements write). The database ends at the old head or the new head, never between.
//   --dry-run  Run every pending file in one transaction, then ROLLBACK: nothing changes, not even
//              the ledger bootstrap. Prints per-file timing and every notice. Implies --atomic.
//
// NOTICE / WARNING messages raised by migrations (raise notice / raise warning) are printed in every
// mode, except the "already exists / does not exist, skipping" noise of IF [NOT] EXISTS statements.
// After at least one file has been committed the runner sends `notify pgrst, 'reload schema'`, so
// PostgREST sees the new columns and functions without waiting for its own DDL watcher.
//
// TLS: the connection uses TLS without certificate verification, as hosted Postgres requires. For a
// local Postgres without TLS put `?sslmode=disable` on DB_URL (a sslmode in the URL overrides this).
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "supabase", "migrations");

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const unknown = flags.filter((f) => f !== "--atomic" && f !== "--dry-run");
if (unknown.length) {
  console.error(`Unknown flag: ${unknown.join(" ")}. Supported: --atomic, --dry-run`);
  process.exit(1);
}
const dryRun = flags.includes("--dry-run");
const atomic = flags.includes("--atomic") || dryRun;

let url;
try {
  url = requireEnv(["DB_URL"], loadEnv()).DB_URL;
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
client.on("notice", (n) => {
  if (/(does not exist|already exists), skipping$/.test(n.message)) return; // IF [NOT] EXISTS noise
  console.log(`\n  ${n.severity ?? "NOTICE"}: ${n.message}`);
});
await client.connect();

let current = "(setup)";
let appliedNow = 0;
const t0 = Date.now();
try {
  if (atomic) {
    await client.query("begin");
    await client.query("set local lock_timeout = '15s'");
    await client.query("set local statement_timeout = '300s'");
  }
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
    current = f;
    const sql = await readFile(path.join(migrationsDir, f), "utf8");
    process.stdout.write("apply " + f + " ... ");
    const t = Date.now();
    if (!atomic) await client.query("begin");
    await client.query(sql);
    await client.query("insert into _nopm_migrations(name) values($1)", [f]);
    if (!atomic) await client.query("commit");
    appliedNow += 1;
    console.log(atomic ? `ok (${Date.now() - t} ms)` : "ok");
  }
  if (atomic) await client.query(dryRun ? "rollback" : "commit");
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error("FAILED\n  " + e.message);
  if (atomic) console.error(`  (in ${current}; all-or-nothing: nothing was applied, the ledger is unchanged)`);
  await client.end();
  process.exit(1);
}

if (dryRun) {
  console.log(`Dry run complete in ${Date.now() - t0} ms: ${appliedNow} pending file(s) applied cleanly, then ROLLED BACK. Nothing changed.`);
} else {
  if (appliedNow > 0) {
    await client.query("notify pgrst, 'reload schema'");
    console.log("PostgREST schema cache reload requested.");
  }
  if (atomic && appliedNow > 0) console.log(`Committed ${appliedNow} file(s) in one transaction (${Date.now() - t0} ms).`);
  console.log("All migrations applied.");
}
await client.end();
