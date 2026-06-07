// NoPM — bootstrap the demo workspace, an admin login user, and scoped maker/checker tokens.
// Idempotent-ish: upserts the workspace, reuses the admin user, and re-mints the two tokens.
// Usage:  node scripts/bootstrap.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TOKEN_PREFIX = env.NOPM_TOKEN_PREFIX || "npm_";
const mintToken = () => {
  const raw = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
};

// 1) Workspace (upsert by slug)
let { data: ws } = await db.from("workspaces").select("id").eq("slug", "demo").maybeSingle();
if (!ws) {
  ws = (await db.from("workspaces").insert({ name: "StillNotBald Programme Office", slug: "demo" }).select("id").single()).data;
}
console.log("workspace:", ws.id);

// 2) Admin login user + profile
const ADMIN_EMAIL = "admin@stillnotbald.com";
const ADMIN_PASSWORD = "NoPMdemo!2026";
let userId;
const created = await db.auth.admin.createUser({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  email_confirm: true,
});
if (created.error) {
  const { data: list } = await db.auth.admin.listUsers();
  userId = list.users.find((u) => u.email === ADMIN_EMAIL)?.id;
} else {
  userId = created.data.user.id;
}
await db.from("profiles").upsert({
  id: userId,
  workspace_id: ws.id,
  email: ADMIN_EMAIL,
  display_name: "Chu Ling",
  role: "admin",
});
console.log("admin user:", ADMIN_EMAIL, "/", ADMIN_PASSWORD);

// 3) Scoped tokens — wipe + re-mint the two demo tokens
await db.from("api_tokens").delete().eq("workspace_id", ws.id).in("name", ["maker (agent)", "checker (agent)"]);
const maker = mintToken();
const checker = mintToken();
await db.from("api_tokens").insert([
  {
    workspace_id: ws.id, name: "maker (agent)", token_hash: maker.hash, prefix: TOKEN_PREFIX, created_by: userId,
    scopes: ["project:*", "milestone:*", "task:read", "task:write", "task:delete:request",
      "risk:*", "issue:*", "clash:*", "resource:*", "budget:*", "time:*", "audit:read"],
  },
  {
    workspace_id: ws.id, name: "checker (agent)", token_hash: checker.hash, prefix: TOKEN_PREFIX, created_by: userId,
    scopes: ["project:read", "task:read", "task:delete:approve", "audit:read"],
  },
]);

console.log("\n=== SCOPED TOKENS (shown once) ===");
console.log("MAKER  :", maker.raw);
console.log("CHECKER:", checker.raw);

// stash for local testing (gitignored)
appendFileSync(envPath, `\n# bootstrap demo tokens (local test only)\nNOPM_MAKER_TOKEN=${maker.raw}\nNOPM_CHECKER_TOKEN=${checker.raw}\nNOPM_WORKSPACE_ID=${ws.id}\n`);
console.log("\nAppended NOPM_MAKER_TOKEN / NOPM_CHECKER_TOKEN to web/.env.local");
