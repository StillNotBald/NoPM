// NoPM — convenience wrapper: load .env.local, derive the Supabase DB_URL from
// NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD (session pooler, IPv4-friendly),
// then delegate to apply-migrations.mjs. Never prints secrets.
//   Usage:  node scripts/migrate.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

if (!process.env.DB_URL) {
  if (env.DB_URL) {
    process.env.DB_URL = env.DB_URL;
  } else {
    const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
    const pwd = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
    // Direct connection (user = postgres, no tenant-in-username). Verified working
    // for this project; the session pooler lives at aws-1-<region> if ever needed.
    process.env.DB_URL = `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`;
  }
}

await import("./apply-migrations.mjs");
