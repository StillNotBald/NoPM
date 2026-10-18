/**
 * Demo-actor detection for the shared, publicly-reachable NoPM demo login
 * (see POST /api/auth/demo-login, DEMO_EMAIL / DEMO_PASSWORD env vars).
 *
 * The demo account is a REAL Supabase Auth session — `Actor.type === "user"`
 * — so nothing about its *shape* distinguishes it from a genuine signed-up
 * user. We resolve it by comparing the session actor's profile email
 * against DEMO_EMAIL.
 *
 * Why email, not `actor.label`: guard.ts's verifySession() builds
 * `Actor.label` as `profile.display_name || profile.email || user.email ||
 * user.id`, and the seeded demo profile HAS a display_name ("Jordan Hale"
 * per scripts/seed.mjs) — so `label` never equals DEMO_EMAIL for the demo
 * account in practice. `Actor` also carries no `email` field (guard.ts is
 * owned by another task in this wave, so we can't add one there). Email via
 * one indexed (primary-key) lookup on `profiles` is the cheapest reliable
 * signal available without changing the Actor shape.
 *
 * Token actors (scoped Bearer PATs) are NEVER the demo account by
 * definition — they authenticate a machine caller, not the shared human
 * login — so we short-circuit to false without touching the database.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";

/** 403 body text for every route that is closed to the shared public demo login. */
export const DEMO_RESTRICTED_MESSAGE = "Not available in the shared demo";

export async function isDemoActor(actor: Actor): Promise<boolean> {
  // Session actors only — token (Bearer PAT) callers are never the shared
  // demo login.
  if (actor.type !== "user") return false;

  const demoEmail = process.env.DEMO_EMAIL;
  if (!demoEmail) return false; // demo account not configured on this deployment

  const db = createAdminClient();
  const { data, error } = await db
    .from("profiles")
    .select("email")
    .eq("id", actor.id)
    .maybeSingle();

  // R-13: fail CLOSED on a read error. Returning false here let the shared demo
  // account pass the demo guards (mint PATs / invites / upload) during a DB
  // hiccup. Throwing makes the guarded route fail (500) instead; this only
  // runs when DEMO_EMAIL is configured and only for session actors, and the
  // same database is needed for the request to do anything useful anyway.
  // A missing profile row (no error) is not the demo account: a session
  // without a profile is already refused by requireAuth.
  if (error) throw error;
  if (!data) return false;

  return data.email === demoEmail;
}
