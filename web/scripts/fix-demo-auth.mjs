#!/usr/bin/env node
/**
 * fix-demo-auth.mjs — repair the public demo login (R-53).
 *
 * The demo entry breaks when the password of the demo auth user drifts from
 * the DEMO_PASSWORD the server env holds (reseed never touches passwords —
 * seed-members creates users with random passwords only when absent). This
 * script makes Supabase match the env again: it finds DEMO_EMAIL's auth user
 * and admin-updates its password to DEMO_PASSWORD. Idempotent.
 *
 * Reads env from process.env first, then web/.env.local (same precedence as
 * auth-smoke). Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DEMO_EMAIL, DEMO_PASSWORD. Exits 1 (without touching anything) when any is
 * missing — an unset DEMO_PASSWORD must never become an empty password.
 *
 * Usage:  node scripts/fix-demo-auth.mjs          (from web/)
 *         also runs as an optional step in .github/workflows/reseed.yml
 */

import { createClient } from "@supabase/supabase-js";
import { loadEnv, requireEnv } from "./lib/env.mjs";

let env;
try {
  env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEMO_EMAIL", "DEMO_PASSWORD"], loadEnv());
} catch (e) {
  console.error(`fix-demo-auth: refusing to run — ${e.message}`);
  process.exit(1);
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers();
if (listError) {
  console.error("fix-demo-auth: listUsers failed:", listError.message);
  process.exit(1);
}
const user = list.users.find((u) => u.email === env.DEMO_EMAIL);
if (!user) {
  console.error(`fix-demo-auth: no auth user found for ${env.DEMO_EMAIL} — run the seed chain first.`);
  process.exit(1);
}

const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
  password: env.DEMO_PASSWORD,
  email_confirm: true,
  ban_duration: "none",
});
if (updateError) {
  console.error("fix-demo-auth: password update failed:", updateError.message);
  process.exit(1);
}

// Prove the fix end-to-end: sign in exactly as the demo-login route does.
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", {
  auth: { persistSession: false },
});
if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  const probe = await anon.auth.signInWithPassword({ email: env.DEMO_EMAIL, password: env.DEMO_PASSWORD });
  if (probe.error) {
    console.error("fix-demo-auth: password set but sign-in probe FAILED:", probe.error.message);
    process.exit(1);
  }
  await anon.auth.signOut();
  console.log(`✓ fix-demo-auth: ${env.DEMO_EMAIL} password reset and sign-in verified.`);
} else {
  console.log(`✓ fix-demo-auth: ${env.DEMO_EMAIL} password reset (no anon key — sign-in not probed).`);
}
