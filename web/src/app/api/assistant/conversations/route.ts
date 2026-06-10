/**
 * GET /api/assistant/conversations
 * Session-user only. Returns the caller's conversations, newest first.
 * Requires scope: assistant:read (always granted to session users).
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const GET = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new ScopeError("AI assistant conversations are only available to human sessions");
  }

  requireScope(actor, "assistant:read");

  const db = createAdminClient();

  const { data: conversations, error } = await db
    .from("assistant_conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", actor.id)
    .eq("workspace_id", actor.workspaceId)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch conversations: ${error.message}`);
  }

  return ok(conversations ?? []);
});
