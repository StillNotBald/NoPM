import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { generateToken } from "@/lib/auth/tokens";
import { DEMO_RESTRICTED_MESSAGE, isDemoActor } from "@/lib/auth/demo";
import type { Actor } from "@/lib/auth/guard";
import { resolveTokenExpiry, tokenDaysLeft, tokenExpiresSoon } from "@/lib/auth/token-life";
import { createTokenSchema } from "./_schema";

export const runtime = "nodejs";

/** Guard: only admin/manager user sessions may manage API tokens. */
function requireTokenAdmin(actor: Actor): void {
  if (
    actor.type !== "user" ||
    !["admin", "manager"].includes(actor.role ?? "")
  ) {
    throw new ScopeError("Token management requires an admin/manager session");
  }
}

// Columns returned to callers — token_hash is NEVER included.
const SAFE_COLUMNS =
  "id, name, prefix, scopes, expires_at, revoked, last_used_at, created_at" as const;

// GET /api/tokens — list this workspace's tokens (sanitized, no token_hash).
// Hides ONLY the assistant's per-turn ephemeral tokens, identified by the
// `kind = 'assistant'` column that lib/assistant/token.ts alone sets (0052).
// It used to hide by NAME prefix, which any token-creator could type to make a
// credential vanish from this inventory.
export const GET = route(async ({ actor, request }) => {
  requireTokenAdmin(actor);

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)),
  );
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("api_tokens")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId)
    .neq("kind", "assistant");

  if (countError) throw countError;

  const { data, error } = await db
    .from("api_tokens")
    .select(SAFE_COLUMNS)
    .eq("workspace_id", actor.workspaceId)
    .neq("kind", "assistant")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  // Decision 21: tell the list which tokens run out soon (< 14 days left).
  const rows = (data ?? []).map((t) => ({
    ...t,
    days_left: tokenDaysLeft(t.expires_at),
    expiring_soon: !t.revoked && tokenExpiresSoon(t.expires_at),
  }));

  return okList(rows, { total: count ?? 0, page, limit });
});

// POST /api/tokens — mint a new API token
export const POST = route(async ({ actor, request }) => {
  requireTokenAdmin(actor);
  // A1-3 / A2-2: the shared public demo login must not mint durable credentials.
  if (await isDemoActor(actor)) throw new ScopeError(DEMO_RESTRICTED_MESSAGE, "demo_restricted");

  const body = await safeJson(request);
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const { name, scopes, expires_at } = parsed.data;
  // Decision 21: default 90 days, at most 365. Existing tokens are untouched.
  const expiry = resolveTokenExpiry(expires_at);
  if (!expiry.ok) {
    return validationError("Validation failed", [{ field: "expires_at", message: expiry.message }]);
  }
  const { raw, hash, prefix } = generateToken();

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("api_tokens")
    .insert({
      workspace_id: actor.workspaceId, // always from actor — never trust body
      name,
      token_hash: hash,
      prefix,
      scopes,
      created_by: actor.id,
      expires_at: expiry.expiresAt,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "token.create",
    targetType: "api_token",
    targetId: row.id,
    before: null,
    after: row,
  });

  // raw token is returned ONCE here and never stored/logged anywhere
  return created({ ...row, token: raw });
});
