import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoActor } from "@/lib/auth/demo";
import {
  preferencesConfigSchema,
  decodePreferencesConfig,
  emptyPreferencesConfig,
  isConfigWithinSizeCap,
  MAX_CONFIG_BYTES,
} from "./_schema";

export const runtime = "nodejs";

/**
 * GET/PUT /api/me/preferences (L-39) — per-user, workspace-scoped DB-
 * persisted display config (columns per register, groupBy per register,
 * density, dateDisplay, defaultLanding).
 *
 * User sessions ONLY — a token/agent actor has no personal display state to
 * own (mirrors PATCH /api/me and the assistant/credentials routes). NOT
 * scope-gated (no `requireScope` call): this is per-account state, not a
 * governed resource, the same reasoning ADR 0009 gives for never routing it
 * through a PAT scope.
 *
 * NO writeAudit call anywhere in this file — per ADR 0009 (amended for this
 * table): per-user DISPLAY preferences are non-governance state.
 *
 * `demo` in the GET response is computed via isDemoActor() so the client can
 * learn, from the SAME call that hydrates its config, whether it must skip
 * PUT entirely and stay cookie/localStorage-only (the shared-demo-identity
 * carve-out — see docs/adr/0009-user-preferences-unaudited.md).
 */

export const GET = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }

  const demo = await isDemoActor(actor);

  const db = createAdminClient();
  const { data, error } = await db
    .from("user_preferences")
    .select("config, updated_at")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;

  return ok({
    config: data ? decodePreferencesConfig(data.config) : emptyPreferencesConfig(),
    updatedAt: data?.updated_at ?? null,
    demo,
  });
});

export const PUT = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new ScopeError("This endpoint requires a session user, not a token.");
  }

  const body = await safeJson<{ config?: unknown }>(request);
  const parsed = preferencesConfigSchema.safeParse(body?.config ?? {});
  if (!parsed.success) {
    return validationError(
      "Invalid preferences config",
      parsed.error.issues.map((e) => ({ field: e.path.join(".") || "config", message: e.message })),
    );
  }

  if (!isConfigWithinSizeCap(parsed.data)) {
    return validationError(`config exceeds the ${MAX_CONFIG_BYTES}-byte size cap`, [
      { field: "config", message: `Serialized config must be at most ${MAX_CONFIG_BYTES} bytes` },
    ]);
  }

  const db = createAdminClient();
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("user_preferences")
    .upsert(
      {
        user_id: actor.id,
        workspace_id: actor.workspaceId,
        config: parsed.data,
        updated_at: now,
      },
      { onConflict: "user_id,workspace_id" },
    )
    .select("config, updated_at")
    .single();

  if (error) throw error;

  // No writeAudit call — ADR 0009 (amended): per-user display preferences,
  // never governance data.
  return ok({
    config: decodePreferencesConfig(data.config),
    updatedAt: data.updated_at,
    demo: await isDemoActor(actor),
  });
});
