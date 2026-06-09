// Assign open tasks to the workspace's human profiles (round-robin) so the
// cross-project "My Tasks" view renders populated for whoever logs in.
// tasks.assignee_id -> profiles(id). Idempotent-ish (re-running re-assigns).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const W = (await db.from("workspaces").select("id").eq("slug", "demo").single()).data.id;
const profiles = (await db.from("profiles").select("id, display_name").eq("workspace_id", W).order("role")).data ?? [];
if (!profiles.length) { console.error("no profiles in workspace"); process.exit(1); }

// Open tasks only (matches the My Tasks page filter). Ordered so round-robin
// spreads each profile across every project.
const tasks = (await db.from("tasks")
  .select("id, status_type")
  .eq("workspace_id", W)
  .not("status_type", "in", '("completed","canceled")')
  .order("created_at")).data ?? [];

let n = 0;
for (let i = 0; i < tasks.length; i++) {
  // Leave ~1 in 6 unassigned for realism.
  if (i % 6 === 5) continue;
  const p = profiles[i % profiles.length];
  const { error } = await db.from("tasks").update({ assignee_id: p.id }).eq("id", tasks[i].id);
  if (!error) n++;
}
const per = {};
for (const p of profiles) {
  per[p.display_name] = (await db.from("tasks").select("id", { count: "exact", head: true })
    .eq("workspace_id", W).eq("assignee_id", p.id)).count;
}
console.log(`✓ assigned ${n} of ${tasks.length} open tasks across ${profiles.length} profiles:`, per);
