/**
 * GET /api/assistant/conversations
 * Session-user only. Returns the caller's conversations, newest first.
 * Requires scope: assistant:read (always granted to session users).
 *
 * Demo actors (the shared demo login) always get an empty list — demo
 * visitors get a fresh chat every visit, never a saved-conversation list.
 * BYOK/non-demo users are completely unchanged.
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { isDemoActor } from "@/lib/auth/demo";

export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new ScopeError("AI assistant conversations are only available to human sessions");
  }

  requireScope(actor, "assistant:read");

  if (await isDemoActor(actor)) {
    return ok([]);
  }

  const db = createAdminClient();

  // Bounded list (A9): newest 50 by default, ?limit= up to 200, ?page= to go further back.
  const sp = new URL(request.url).searchParams;
  const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50));
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);

  const { data: conversations, error } = await db
    .from("assistant_conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .order("updated_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) {
    throw new Error(`Failed to fetch conversations: ${error.message}`);
  }

  return ok(conversations ?? []);
});
