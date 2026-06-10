/**
 * GET /api/assistant/conversations/[id]
 * Session-user only. Returns messages for the given conversation.
 * Verifies conversation.user_id === actor.id (else 404).
 * Requires scope: assistant:read.
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError, NotFoundError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const GET = route(async ({ actor, params }) => {
  if (actor.type !== "user") {
    throw new ScopeError("AI assistant conversations are only available to human sessions");
  }

  requireScope(actor, "assistant:read");

  const { id } = params;

  const db = createAdminClient();

  // Verify the conversation belongs to this user
  const { data: conv } = await db
    .from("assistant_conversations")
    .select("id, user_id, title, created_at, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (!conv || conv.user_id !== actor.id) {
    throw new NotFoundError("Conversation not found");
  }

  // Fetch messages ordered by creation time
  const { data: messages, error } = await db
    .from("assistant_messages")
    .select("id, role, content, actions, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch messages: ${error.message}`);
  }

  return ok({
    conversation: {
      id: conv.id,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
    },
    messages: messages ?? [],
  });
});
