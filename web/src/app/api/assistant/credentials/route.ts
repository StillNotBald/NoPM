import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ScopeError, ApiError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, noContent, safeJson } from "@/lib/api/response";
import { encrypt } from "@/lib/crypto";

export const runtime = "nodejs";

/**
 * GET /api/assistant/credentials
 * Returns connection status for the current session user.
 * NEVER returns the encrypted or plaintext API key.
 *
 * Response: { data: { connected: boolean, provider?: string, model?: string, demoAvailable: boolean } }
 */
export const GET = route(async ({ actor }) => {
  // Session-user only — reject token actors before any other check.
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }
  requireScope(actor, "assistant:read"); // blocks viewers on write paths; read is allowed

  const demoAvailable = Boolean(process.env.NOPM_DEMO_LLM_KEY);
  const db = createAdminClient();

  const { data, error } = await db
    .from("assistant_credentials")
    .select("provider, model")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  if (!data) {
    return ok({ connected: false, demoAvailable });
  }

  return ok({
    connected: true,
    provider: data.provider as string,
    model: data.model as string,
    demoAvailable,
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
  const api_key_enc = encrypt(apiKey);
  const now = new Date().toISOString();

  const db = createAdminClient();

  const { error } = await db.from("assistant_credentials").upsert(
    {
      workspace_id: actor.workspaceId,
      user_id: actor.id,
      provider,
      api_key_enc,
      model,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );

  if (error) throw new Error(error.message);

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

  const { error } = await db
    .from("assistant_credentials")
    .delete()
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId);

  if (error) throw new Error(error.message);

  return noContent();
});
