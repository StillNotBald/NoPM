// Global setup: mint browser storage states for the two e2e identities.
//   admin — real admin session minted server-side (same technique as scripts/auth-smoke.mjs:
//           Supabase admin generateLink + verifyOtp, then the @supabase/ssr cookie format).
//   demo  — whatever POST /api/auth/demo-login hands out (the public entry-path identity).
// States land in e2e/.auth/*.json (gitignored). Specs skip themselves if a state is missing.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.join(here, ".auth");

function loadEnv() {
  let fileEnv = {};
  try {
    fileEnv = Object.fromEntries(
      readFileSync(path.join(here, "..", ".env.local"), "utf8")
        .split(/\r?\n/)
        .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    // no .env.local — CI provides everything via process.env
  }
  return { ...fileEnv, ...process.env };
}

// @supabase/ssr cookie: "base64-" + base64url(JSON(session)), chunked at 3180.
function sessionCookies(ref, session, domain) {
  const val = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  const name = `sb-${ref}-auth-token`;
  const pairs =
    val.length <= 3180
      ? [[name, val]]
      : Array.from({ length: Math.ceil(val.length / 3180) }, (_, n) => [
          `${name}.${n}`,
          val.slice(n * 3180, n * 3180 + 3180),
        ]);
  return pairs.map(([k, v]) => ({
    name: k,
    value: v,
    domain,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 60 * 60 * 8,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  }));
}

export default async function globalSetup() {
  const env = loadEnv();
  const BASE = process.env.BASE || "http://localhost:3000";
  const domain = new URL(BASE).hostname;
  mkdirSync(authDir, { recursive: true });

  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[e2e setup] Supabase env missing — admin-authenticated specs will be skipped.");
    return;
  }
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const email = env.ADMIN_EMAIL || "admin@stillnotbald.com";

  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  const gl = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (gl.error) throw new Error(`[e2e setup] generateLink failed: ${gl.error.message}`);
  let v = await anon.auth.verifyOtp({ type: "email", token_hash: gl.data.properties.hashed_token });
  if (v.error) v = await anon.auth.verifyOtp({ type: "magiclink", token_hash: gl.data.properties.hashed_token });
  if (v.error || !v.data.session) throw new Error(`[e2e setup] verifyOtp failed: ${v.error?.message}`);

  writeFileSync(
    path.join(authDir, "admin.json"),
    JSON.stringify({ cookies: sessionCookies(ref, v.data.session, domain), origins: [] }, null, 2),
  );
  console.log(`[e2e setup] admin storage state minted for ${email} @ ${domain}`);
}
