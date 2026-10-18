// NoPM local-DB probes — tiny HTTP client for the LOCAL app under test.
//
// The app must be a local `next start` (see README) wired to the SAME local
// Supabase stack the fixtures were created in. Tokens and users minted by the
// fixtures only exist in that stack, so a green "PAT authenticates" check is
// also proof the app is not pointed at some other database.
import "./guard.mjs";
import { stack, needAnonKey } from "./guard.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerClient } from "@supabase/ssr";
import { errText } from "./report.mjs";

// web/.env.local holds the LIVE project's credentials in a normal checkout. `next start`
// loads it for any variable the shell did not set, so with that file present the app under
// test could quietly fall back to the live Supabase project. These probes refuse to run then.
const ENV_LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP call to the local app. Never throws on a non-2xx; returns { status, json, text, headers }. */
export async function call(method, pathname, { token, cookie, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (cookie) h.cookie = cookie;
  let payload;
  if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(stack.appUrl + pathname, {
    method,
    headers: h,
    body: payload,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. text/calendar)
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Exit 3 with a clear message unless the local app answers /api/health. */
export async function requireApp() {
  if (existsSync(ENV_LOCAL) && !process.env.ALLOW_ENV_LOCAL) {
    console.error("LOCAL-DB GUARD: web/.env.local exists. `next start` would load it for any variable not set in the shell,");
    console.error("so the app under test could fall back to the LIVE Supabase project. Move that file away (or set");
    console.error("ALLOW_ENV_LOCAL=1 only if you have verified every NEXT_PUBLIC_SUPABASE_* / SUPABASE_* var is set to the local stack).");
    process.exit(2);
  }
  try {
    const r = await call("GET", "/api/health");
    if (r.status !== 200) throw new Error(`/api/health answered ${r.status}`);
  } catch (e) {
    console.error(`Cannot reach the local app at ${stack.appUrl}: ${e.message}`);
    console.error("Start it first (build with the LOCAL env, then `npm run start`) — see web/scripts/local-db/README.md.");
    process.exit(3);
  }
}

/**
 * Real session cookies for a fixture user, produced by @supabase/ssr itself
 * (so the chunking / base64 encoding is exactly what the app's server client
 * reads) — sign in against the local GoTrue with an in-memory cookie jar.
 */
export async function sessionCookie(user) {
  const jar = new Map();
  const client = createServerClient(stack.supabaseUrl, needAnonKey(), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in as ${user.label} failed: ${errText(error)}`);
  for (let i = 0; i < 40 && jar.size === 0; i++) await sleep(50);
  if (jar.size === 0) throw new Error(`no auth cookies were produced for ${user.label}`);
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}
