#!/usr/bin/env node
/**
 * NoPM — one-command self-host setup for a fresh Supabase project (R-88).
 *
 * Idempotent: safe to run again against the same project (migrations skip
 * what's already applied, bootstrap upserts the workspace/admin/tokens).
 *
 * Usage (from web/, or `npm run setup` from web/ or the repo root):
 *   node scripts/setup.mjs                run the full bootstrap
 *   node scripts/setup.mjs --dry-run      print the plan; touch nothing (no network calls at all)
 *   node scripts/setup.mjs --seed         also populate the full demo dataset after bootstrap
 *
 * What it does, in order:
 *   1. Check required env — fail with a plain-English list before touching anything.
 *   2. Apply every SQL migration in supabase/migrations/ (delegates to apply-migrations.mjs).
 *   3. `notify pgrst, 'reload schema'` — PostgREST caches the schema; without this, the
 *      REST API 400s/404s against tables that were just created by step 2.
 *   4. Bootstrap the workspace + admin login + scoped maker/checker tokens (delegates to
 *      bootstrap.mjs).
 *   5. Optionally run the full demo seed chain (--seed), the same chain as `npm run seed:all`.
 *   6. Print next steps: app URL, how to mint a token, how to connect an agent — never the
 *      admin password or any secret.
 *
 * Env is read via scripts/lib/env.mjs: process.env always wins over web/.env.local, and a
 * missing .env.local is fine — a fresh self-host has no reason to have one. See
 * docs/SELF_HOSTING.md for where each value comes from.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv, requireEnv } from "./lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");
const DO_SEED = process.argv.includes("--seed");

function mask(value) {
  if (!value) return "(unset)";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "…" + value.slice(-4);
}

function fail(message) {
  console.error(`\nsetup: ${message}\n`);
  process.exit(1);
}

function run(scriptRelPath, extraEnv, label) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(process.execPath, [path.join(here, scriptRelPath)], {
    cwd: here,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${result.status ?? "?"}). See output above.`);
  }
}

// ── 1. Resolve + validate env ────────────────────────────────────────────────
const env = loadEnv();

// The app itself needs these to run at all (see web/src/lib/supabase/*.ts,
// web/src/lib/crypto.ts). Read from web/src/lib/crypto.ts to confirm the
// encryption key var name — it is NOPM_ENCRYPTION_KEY, not e.g. ENCRYPTION_KEY.
const APP_REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NOPM_ENCRYPTION_KEY",
];
// This script additionally needs a way to reach Postgres directly (for
// migrations + the PostgREST schema-reload notify) and an admin identity to
// bootstrap.
const SETUP_REQUIRED = ["ADMIN_EMAIL", "ADMIN_PASSWORD"];

try {
  requireEnv(APP_REQUIRED, env);
  requireEnv(SETUP_REQUIRED, env);
  if (!env.DB_URL) {
    requireEnv(["SUPABASE_DB_PASSWORD"], env);
  }
} catch (e) {
  fail(e.message);
}

// Derive DB_URL the same way scripts/migrate.mjs does, if not set directly.
const dbUrl =
  env.DB_URL ||
  (() => {
    const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
    const pwd = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
    return `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`;
  })();

const supabaseRef = (() => {
  try {
    return new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  } catch {
    return "(invalid NEXT_PUBLIC_SUPABASE_URL)";
  }
})();

// ── Plan (always printed; --dry-run stops here, before any network I/O) ─────
console.log("NoPM self-host setup");
console.log("=====================");
console.log(`Supabase project     : ${supabaseRef}`);
console.log(`Supabase URL         : ${env.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`Service role key     : ${mask(env.SUPABASE_SERVICE_ROLE_KEY)}`);
console.log(`Anon key             : ${mask(env.NEXT_PUBLIC_SUPABASE_ANON_KEY)}`);
console.log(`DB connection        : ${dbUrl.replace(/:[^:@/]+@/, ":****@")}`);
console.log(`Encryption key       : ${mask(env.NOPM_ENCRYPTION_KEY)}`);
console.log(`Admin email          : ${env.ADMIN_EMAIL}`);
console.log(`Admin password       : ${mask(env.ADMIN_PASSWORD)}`);
console.log(`Seed demo data       : ${DO_SEED ? "yes (--seed)" : "no"}`);
console.log("\nPlan:");
console.log("  1. Apply every SQL migration in web/supabase/migrations/ (idempotent).");
console.log("  2. notify pgrst, 'reload schema' — refresh PostgREST's cached schema.");
console.log("  3. Bootstrap the workspace + admin login + scoped maker/checker tokens.");
let planStep = 4;
if (DO_SEED) console.log(`  ${planStep++}. Run the full demo seed chain (npm run seed:all equivalent).`);
console.log(`  ${planStep}. Print next steps (URL, how to mint a token, how to connect an agent).`);

if (DRY_RUN) {
  console.log("\n--dry-run: stopping here. No database connection was made, no writes occurred.");
  process.exit(0);
}

// ── 2. Migrations ────────────────────────────────────────────────────────────
run("apply-migrations.mjs", { DB_URL: dbUrl }, "Applying migrations");

// ── 3. PostgREST schema reload ───────────────────────────────────────────────
// Learned the hard way on this project: after DDL, PostgREST keeps serving
// its stale cached schema until told to reload — a bad column silently reads
// back as an empty result set rather than an error. See docs/SELF_HOSTING.md.
console.log("\n→ Reloading PostgREST schema cache");
{
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query("notify pgrst, 'reload schema'");
    console.log("  done.");
  } catch (e) {
    console.warn(`  warning: schema reload notify failed (${e.message}). If API calls 404 against`);
    console.warn("  newly created tables, run this manually: select pg_notify('pgrst', 'reload schema');");
  } finally {
    await client.end().catch(() => {});
  }
}

// ── 4. Bootstrap workspace + admin + tokens ─────────────────────────────────
run(
  "bootstrap.mjs",
  {
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    ADMIN_EMAIL: env.ADMIN_EMAIL,
    ADMIN_PASSWORD: env.ADMIN_PASSWORD,
    NOPM_TOKEN_PREFIX: env.NOPM_TOKEN_PREFIX,
    NOPM_WORKSPACE_SLUG: env.NOPM_WORKSPACE_SLUG,
    NOPM_WORKSPACE_NAME: env.NOPM_WORKSPACE_NAME,
  },
  "Bootstrapping workspace, admin login, and scoped tokens",
);

// ── 5. Optional demo seed chain ──────────────────────────────────────────────
if (DO_SEED) {
  const seedEnv = {
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  };
  const seedChain = [
    "seed.mjs",
    "seed-members.mjs",
    "seed-approvals.mjs",
    "seed-change-control.mjs",
    "seed-people-link.mjs",
    "seed-documents.mjs",
    "seed-document-files.mjs",
    "seed-baselines.mjs",
    "seed-mainline-deps.mjs",
    "seed-sprints-timesheets.mjs",
  ];
  for (const script of seedChain) {
    run(script, seedEnv, `Seeding: ${script}`);
  }
}

// ── 6. Next steps (never print secrets) ──────────────────────────────────────
const appUrl = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
console.log("\n=====================================================================");
console.log("NoPM is set up.");
console.log("=====================================================================");
console.log(`\n1. Start the app:        npm run dev   (or: npm run build && npm start)`);
console.log(`2. Sign in at:           ${appUrl}  as ${env.ADMIN_EMAIL}`);
console.log(`   (password is whatever you set as ADMIN_PASSWORD — not printed here)`);
console.log(`3. Mint an API token:    Settings → API Tokens, in the running app`);
console.log(`   (bootstrap also minted a demo maker/checker pair — see`);
console.log(`   web/.env.local if one was created; tokens are shown once and`);
console.log(`   never re-printed)`);
console.log(`4. Connect an agent:`);
console.log(`   - CLI/REST:  set NOPM_API_URL=${appUrl} and NOPM_TOKEN=<your token>`);
console.log(`   - MCP:       npm run mcp   (stdio server; see web/mcp/README.md)`);
console.log(`\nSee docs/SELF_HOSTING.md for Docker / Vercel / manual deployment paths.`);
