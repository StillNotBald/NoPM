// NoPM — shared env loader for ops scripts (seed/bootstrap/setup/migrate/smoke).
//
// Precedence: process.env always wins over web/.env.local. The file is
// optional — a missing web/.env.local is not an error, it just means every
// value has to come from real environment variables (CI, Docker, a fresh
// self-host). This is what lets the exact same scripts run against a local
// .env.local during development and against injected env vars everywhere
// else (see docs/SELF_HOSTING.md).
//
// Path resolution is anchored to this file's own location (web/scripts/lib/),
// not the caller's cwd, so it works the same whether a script is invoked as
// `node scripts/foo.mjs` from web/ or `npm run foo` from the repo root.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ENV_LOCAL_PATH = path.join(here, "..", "..", ".env.local"); // web/.env.local

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    out[key] = val;
  }
  return out;
}

let cachedFileEnv = null;
function readEnvLocal() {
  if (cachedFileEnv) return cachedFileEnv;
  if (!existsSync(ENV_LOCAL_PATH)) {
    cachedFileEnv = {};
    return cachedFileEnv;
  }
  try {
    cachedFileEnv = parseEnvFile(readFileSync(ENV_LOCAL_PATH, "utf8"));
  } catch {
    cachedFileEnv = {};
  }
  return cachedFileEnv;
}

/**
 * Merge web/.env.local (if present) with process.env, process.env always
 * winning. Safe to call repeatedly and from any script — the file is read
 * once and cached.
 */
export function loadEnv() {
  return { ...readEnvLocal(), ...process.env };
}

/**
 * Assert that every name in `names` is present and non-blank in the merged
 * env (or in an `env` object you already loaded via loadEnv()). Throws a
 * plain-English Error listing exactly what's missing and where to get it,
 * instead of letting the caller fail later with a cryptic TypeError.
 */
export function requireEnv(names, env = loadEnv()) {
  const missing = names.filter((n) => !env[n] || !String(env[n]).trim());
  if (missing.length) {
    const plural = missing.length > 1;
    throw new Error(
      `Missing required environment variable${plural ? "s" : ""}: ${missing.join(", ")}\n` +
        `Set ${plural ? "them" : "it"} in web/.env.local, or as real environment variables ` +
        `(process.env always takes precedence over web/.env.local).\n` +
        `See web/.env.example for what each one means, and docs/SELF_HOSTING.md for where to get Supabase values.`,
    );
  }
  return env;
}
