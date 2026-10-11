// NoPM — bootstrap the demo workspace, an admin login user, and scoped maker/checker tokens.
// Idempotent-ish: upserts the workspace, reuses the admin user, and re-mints the two tokens.
// Usage:  node scripts/bootstrap.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv, requireEnv, ENV_LOCAL_PATH } from "./lib/env.mjs";

const env = requireEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], loadEnv());

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TOKEN_PREFIX = env.NOPM_TOKEN_PREFIX || "npm_";
const mintToken = () => {
  const raw = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
};

// Workspace slug/name — env-overridable so an enterprise install can set its
// own workspace instead of the shipped demo. Defaults preserve today's
// behavior exactly when unset (no behavior change for existing callers).
const WORKSPACE_SLUG = process.env.NOPM_WORKSPACE_SLUG || "demo";
const WORKSPACE_NAME = process.env.NOPM_WORKSPACE_NAME || "StillNotBald Programme Office";

// 1) Workspace (upsert by slug)
let { data: ws } = await db.from("workspaces").select("id").eq("slug", WORKSPACE_SLUG).maybeSingle();
if (!ws) {
  ws = (await db.from("workspaces").insert({ name: WORKSPACE_NAME, slug: WORKSPACE_SLUG }).select("id").single()).data;
}
console.log("workspace:", ws.id);

// 2) Admin login user + profile
const ADMIN_EMAIL = env.ADMIN_EMAIL || "admin@stillnotbald.com";
const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "";
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
  display_name: "Jordan Hale",
  role: "admin",
});
console.log("admin user:", ADMIN_EMAIL, "(password from ADMIN_PASSWORD, not printed)");

// 3) Scoped tokens — wipe + re-mint the two demo tokens
await db.from("api_tokens").delete().eq("workspace_id", ws.id).in("name", ["maker (agent)", "checker (agent)"]);
const maker = mintToken();
const checker = mintToken();
await db.from("api_tokens").insert([
  {
    workspace_id: ws.id, name: "maker (agent)", token_hash: maker.hash, prefix: TOKEN_PREFIX, created_by: userId,
    // project scopes are EXPLICIT, never "project:*" — hasScope()'s resource
    // wildcard would silently include project:delete:approve, letting the
    // maker approve its own project deletions (four-eyes defeat at the token
    // layer). Same rule for any future resource that grows an approve scope.
    scopes: ["project:read", "project:write", "project:delete:request",
      "milestone:*", "task:read", "task:write", "task:delete:request",
      "risk:*", "issue:*", "clash:*", "resource:*", "budget:*", "time:*", "audit:read"],
  },
  {
    workspace_id: ws.id, name: "checker (agent)", token_hash: checker.hash, prefix: TOKEN_PREFIX, created_by: userId,
    scopes: ["project:read", "task:read", "task:delete:approve", "project:delete:approve", "rebaseline:approve", "audit:read"],
  },
]);

console.log("\n=== SCOPED TOKENS (shown once) ===");
console.log("MAKER  :", maker.raw);
console.log("CHECKER:", checker.raw);

// Stash for local testing (gitignored). Only when a .env.local already exists
// (a pure-env self-host never gets a surprise plaintext-secret file), and
// replace-in-place so reruns do not leave stale duplicate token lines behind.
if (existsSync(ENV_LOCAL_PATH)) {
  const keys = ["NOPM_MAKER_TOKEN", "NOPM_CHECKER_TOKEN", "NOPM_WORKSPACE_ID"];
  const marker = "# bootstrap demo tokens (local test only)";
  const kept = readFileSync(ENV_LOCAL_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => !keys.some((k) => line.startsWith(k + "=")) && line.trim() !== marker);
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push("", marker, `NOPM_MAKER_TOKEN=${maker.raw}`, `NOPM_CHECKER_TOKEN=${checker.raw}`, `NOPM_WORKSPACE_ID=${ws.id}`, "");
  writeFileSync(ENV_LOCAL_PATH, kept.join("\n"));
  console.log("\nWrote NOPM_MAKER_TOKEN / NOPM_CHECKER_TOKEN / NOPM_WORKSPACE_ID into web/.env.local (previous values replaced)");
} else {
  console.log("\nNo web/.env.local present; the tokens above were shown once and are not stored in plaintext anywhere.");
}
