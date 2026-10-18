// NoPM local-DB probes — LOCAL-ONLY GUARD.
//
// Every probe imports this module FIRST. It runs at import time and refuses to
// let the process continue unless every network target the probes will touch
// (Supabase API, Postgres, the app under test) is a loopback address, and the
// service-role key is not a hosted-project key. These probes insert users,
// tokens, workspaces and audit rows (audit_log is append-only: nothing they
// write can be removed) — pointed at a live project they would pollute a real
// governance trail irrecoverably. So the guard is deliberately paranoid and
// does NOT read web/.env.local (that file holds the live project's
// credentials): the only inputs are process.env and an optional stack env file
// produced by `supabase status -o env`.
//
// Exit code 2 = refused by the guard (distinct from 1 = a probe FAILED).
import { existsSync, readFileSync } from "node:fs";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function refuse(message) {
  console.error("");
  console.error("============================================================");
  console.error(" LOCAL-DB GUARD: REFUSING TO RUN");
  console.error("============================================================");
  console.error(message);
  console.error("");
  console.error("These probes only run against a LOCAL Supabase stack");
  console.error("(`npx supabase start`) and a LOCAL app (`next start`).");
  console.error("See web/scripts/local-db/README.md.");
  process.exit(2);
}

/** Parse `KEY="value"` / `KEY=value` lines (the `supabase status -o env` format). */
function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    out[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// process.env always wins over the optional stack file (same precedence rule
// as scripts/lib/env.mjs, but WITHOUT the web/.env.local fallback — see header).
let fileEnv = {};
const stackFile = process.env.LOCAL_STACK_ENV;
if (stackFile) {
  if (!existsSync(stackFile)) refuse(`LOCAL_STACK_ENV points at a file that does not exist: ${stackFile}`);
  fileEnv = parseEnvText(readFileSync(stackFile, "utf8"));
}
const pick = (...names) => {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
    if (fileEnv[n]) return fileEnv[n];
  }
  return undefined;
};

/** Throw-free host check: returns the parsed URL or refuses the whole process. */
export function assertLocalUrl(label, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse(`${label} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol)) {
    refuse(`${label} has an unexpected protocol: ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    refuse(
      `${label} host is "${url.hostname}", which is not a loopback address.\n` +
        `Allowed hosts: 127.0.0.1, localhost, ::1.`,
    );
  }
  return url;
}

/** Hosted-project keys are JWTs carrying a `ref` claim; local CLI keys never do. */
function assertNotHostedKey(label, key) {
  if (!key || key.split(".").length !== 3) return; // opaque (sb_secret_…) keys cannot be inspected
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
    if (payload.ref || (typeof payload.iss === "string" && payload.iss.includes("supabase.co"))) {
      refuse(`${label} looks like a HOSTED Supabase project key (it carries a project ref / supabase.co issuer).`);
    }
  } catch {
    // Not decodable — leave it to the URL check, which is the primary gate.
  }
}

/** What the probes read. Required values are validated lazily by `need()`. */
const supabaseUrl = pick("SUPABASE_URL", "API_URL", "NEXT_PUBLIC_SUPABASE_URL");
if (!supabaseUrl) {
  refuse(
    "No Supabase URL. Set SUPABASE_URL (or LOCAL_STACK_ENV=<file from `npx supabase status -o env`>).",
  );
}
const supabase = assertLocalUrl("SUPABASE_URL", supabaseUrl);

const serviceKey = pick("SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY", "SECRET_KEY");
const anonKey = pick("SUPABASE_ANON_KEY", "ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "PUBLISHABLE_KEY");
if (!serviceKey) refuse("No service-role key. Set SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY via LOCAL_STACK_ENV).");
assertNotHostedKey("service-role key", serviceKey);
if (anonKey) assertNotHostedKey("anon key", anonKey);

// Direct Postgres: defaults to the Supabase CLI's documented local DB URL.
const dbUrl = pick("DB_URL", "SUPABASE_DB_URL") ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
assertLocalUrl("DB_URL", dbUrl);

// The app under test (API-layer probes only); optional until a probe asks.
const appUrlRaw = pick("APP_URL") ?? "http://localhost:3000";
const appUrl = assertLocalUrl("APP_URL", appUrlRaw).origin;

export const stack = Object.freeze({
  supabaseUrl: supabase.origin,
  serviceKey,
  anonKey,
  dbUrl,
  appUrl,
});

/** Probes that need the anon key (session sign-in) call this to fail loudly if it is missing. */
export function needAnonKey() {
  if (!stack.anonKey) {
    refuse("This probe needs SUPABASE_ANON_KEY (ANON_KEY in `supabase status -o env`).");
  }
  return stack.anonKey;
}

console.log(`[guard] local stack OK  api=${stack.supabaseUrl}  db=${new URL(stack.dbUrl).host}  app=${stack.appUrl}`);
