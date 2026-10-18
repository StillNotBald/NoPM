import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ScopeError, ApiError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, noContent, safeJson } from "@/lib/api/response";
import { encrypt } from "@/lib/crypto";
import { isDemoActor } from "@/lib/auth/demo";
import { auditedDelete, auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import { isKnownProvider, verifyProviderKey } from "@/lib/assistant/providers/verify";

export const runtime = "nodejs";

/**
 * GET /api/assistant/credentials
 * Returns connection status for the current session user.
 * NEVER returns the encrypted or plaintext API key.
 *
 * Response: { data: { connected: boolean, provider?: string, model?: string, demoAvailable: boolean, demoSession: boolean } }
 */
export const GET = route(async ({ actor }) => {
  // Session-user only — reject token actors before any other check.
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }
  requireScope(actor, "assistant:read"); // blocks viewers on write paths; read is allowed

  const demoAvailable = Boolean(process.env.NOPM_DEMO_LLM_KEY);
  const demoSession = await isDemoActor(actor);
  const db = createAdminClient();

  const { data, error } = await db
    .from("assistant_credentials")
    .select("provider, model")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    return ok({ connected: false, demoAvailable, demoSession });
  }

  return ok({
    connected: true,
    provider: data.provider as string,
    model: data.model as string,
    demoAvailable,
    demoSession,
  });
});

/**
 * PUT /api/assistant/credentials
 * Stores (or replaces) an encrypted API key for the current session user.
 * Body: { provider: string, apiKey: string, model: string }
 *
 * Response: { data: { connected: true, provider: string, model: string } }
 */
export const PUT = route(async ({ actor, request }) => {
  // Session-user only.
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }
  requireScope(actor, "assistant:write"); // blocks viewers

  type Body = { provider?: string; apiKey?: string; model?: string };
  const body = await safeJson<Body>(request);

  if (!body || !body.provider || !body.apiKey || !body.model) {
    throw new ApiError(422, "provider, apiKey, and model are required.", "validation_error");
  }

  const { provider, apiKey, model } = body;

  // Q-ACC-12: an unknown provider is refused, and the key is tested BEFORE anything is stored.
  if (!isKnownProvider(provider)) {
    throw new ApiError(422, "Unknown provider. Use openai, anthropic, google or openrouter.", "unknown_provider");
  }
  const verdict = await verifyProviderKey(provider, apiKey);
  if (verdict === "invalid") {
    throw new ApiError(422, "That key did not work with this provider. Check it and try again.", "invalid_key");
  }
  if (verdict === "unreachable") {
    throw new ApiError(422, "Could not check that key with the provider right now. Try again in a minute.", "key_unverified");
  }
  const api_key_enc = encrypt(apiKey);
  const now = new Date().toISOString();

  const db = createAdminClient();

  // Read the existing row FIRST: the audit before/after payloads carry only
  // {provider, model}, NEVER apiKey/api_key_enc (the encrypted secret must
  // never reach the audit_log), so they are passed explicitly below.
  const { data: before, error: beforeError } = await db
    .from("assistant_credentials")
    .select("id, provider, model")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (beforeError) throw new Error(beforeError.message);

  // user_id is set on insert only: the update path may not touch it (migration 0103 narrows the columns).
  const patch = { provider, api_key_enc, model, updated_at: now };
  const auditBefore = before ? { provider: before.provider, model: before.model } : null;
  const auditAfter = { provider, model };
  const replace = (id: string) =>
    auditedUpdate({ table: "assistant_credentials", actor, action: "assistant.credential.set", id, patch, auditBefore, auditAfter, omitColumns: ["api_key_enc"] });
  // The write and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  // First connection inserts; a replacement updates. Two first connections racing hit the
  // unique user_id (23505) and the loser falls back to the update.
  if (before) {
    await replace(before.id as string);
  } else {
    try {
      await auditedInsert({ table: "assistant_credentials", actor, action: "assistant.credential.set", patch: { user_id: actor.id, ...patch }, auditBefore, auditAfter, omitColumns: ["api_key_enc"] });
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "23505") throw e;
      const { data: raced, error: racedError } = await db
        .from("assistant_credentials")
        .select("id")
        .eq("user_id", actor.id)
        .eq("workspace_id", actor.workspaceId)
        .maybeSingle();
      if (racedError || !raced) throw racedError ?? e;
      await replace(raced.id as string);
    }
  }

  return ok({ connected: true as const, provider, model });
});

/**
 * DELETE /api/assistant/credentials
 * Removes the stored credential for the current session user.
 *
 * Response: 204 No Content
 */
export const DELETE = route(async ({ actor }) => {
  // Session-user only.
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }
  requireScope(actor, "assistant:write"); // blocks viewers

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("assistant_credentials")
    .select("id, provider, model")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);

  // No row to revoke: keep current 204 semantics, no audit row (nothing
  // happened — writeAudit is fail-closed for actual mutations only).
  if (!existing) return noContent();

  // The delete and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  await auditedDelete({
    table: "assistant_credentials",
    actor,
    action: "assistant.credential.revoke",
    omitColumns: ["api_key_enc"],
    id: existing.id as string,
    auditBefore: { provider: existing.provider, model: existing.model },
    auditAfter: null,
  });

  return noContent();
});
