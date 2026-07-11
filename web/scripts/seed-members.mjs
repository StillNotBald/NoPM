// Seed a second human member (a PMO change authority) into the 'demo' workspace
// so maker-checker / four-eyes flows have a distinct requester and approver.
// Idempotent: reuses the auth user if the email already exists.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;

const members = [
  { email: "priya.nair@stillnotbald.com", display_name: "Priya Nair", role: "manager" },
  { email: "daniel.okoro@stillnotbald.com", display_name: "Daniel Okoro", role: "member" },
];

for (const m of members) {
  let userId;
  const created = await db.auth.admin.createUser({
    email: m.email,
    password: randomBytes(18).toString("base64url"),
    email_confirm: true,
    user_metadata: { display_name: m.display_name },
  });
  if (created.error) {
    const { data: list } = await db.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === m.email)?.id;
  } else {
    userId = created.data.user.id;
  }
  if (!userId) { console.error("could not resolve user for", m.email); continue; }
  const { error } = await db.from("profiles").upsert({
    id: userId, workspace_id: W, role: m.role, display_name: m.display_name, email: m.email,
  });
  if (error) { console.error("profile upsert failed", m.email, error.message); continue; }
  console.log("member ready:", m.display_name, "/", m.role);
}

// ── ensure the shared demo login can drive the full demo ────────────────────
// The one-click demo account (DEMO_EMAIL) must be a manager, not a viewer:
// requireScope blocks viewers from every non-read action, which would 403
// the flagship moments (Kanban drag, approving the seeded deletion request,
// assistant write tools). The workspace is reset nightly (reseed.yml), which
// bounds what a visitor can mess up. Idempotent; warns if the profile is
// missing rather than creating it (the auth user is provisioned outside the
// seed pipeline).
if (env.DEMO_EMAIL) {
  const { data: demoProfile } = await db
    .from("profiles").select("id, role").eq("workspace_id", W).eq("email", env.DEMO_EMAIL).maybeSingle();
  if (!demoProfile) {
    console.warn(`demo profile not found for ${env.DEMO_EMAIL} — one-click demo role not enforced`);
  } else if (demoProfile.role !== "manager") {
    const { error } = await db.from("profiles").update({ role: "manager" }).eq("id", demoProfile.id);
    if (error) console.error("demo role update failed:", error.message);
    else console.log(`demo account promoted to manager (was ${demoProfile.role})`);
  } else {
    console.log("demo account already manager");
  }
} else {
  console.warn("DEMO_EMAIL not set — skipping demo-account role enforcement");
}
console.log("✓ members seeded.");
