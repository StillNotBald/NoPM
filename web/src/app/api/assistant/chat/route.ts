/**
 * POST /api/assistant/chat
 * Session-user only (not token actors).
 * Runs the agentic assistant loop, persists the conversation, and returns
 * { reply, actions, usedDemoKey, conversation_id }.
 *
 * When body.stream === true the response is a ReadableStream of NDJSON events:
 *   { type: "actions",  actions: Action[] }
 *   { type: "token",    text: string }      (one or more)
 *   { type: "done",     conversation_id: string, usedDemoKey: boolean }
 * On any error during streaming, a { type: "error", message: string } is emitted.
 * The non-stream JSON path is byte-for-byte unchanged.
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { runAssistant, runAssistantStream } from "@/lib/assistant/index";
import { createAdminClient } from "@/lib/supabase/admin";

export const POST = route(async ({ actor, request }) => {
  // Session-user only — token actors are rejected
  if (actor.type !== "user") {
    throw new ScopeError("AI assistant is only available to human sessions");
  }

  const body = await safeJson<{
    message?: unknown;
    history?: unknown;
    conversation_id?: unknown;
    stream?: unknown;
  }>(request);

  if (!body || typeof body.message !== "string" || body.message.trim() === "") {
    return validationError("Validation failed", [
      { field: "message", message: "message is required and must be a non-empty string" },
    ]);
  }

  const message = body.message.trim();

  // Validate history if provided
  let history: { role: "user" | "assistant"; content: string }[] = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) {
      return validationError("Validation failed", [
        { field: "history", message: "history must be an array" },
      ]);
    }
    for (const entry of body.history) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !["user", "assistant"].includes(entry.role) ||
        typeof entry.content !== "string"
      ) {
        return validationError("Validation failed", [
          { field: "history", message: "each history entry must have role (user|assistant) and content (string)" },
        ]);
      }
    }
    history = body.history as { role: "user" | "assistant"; content: string }[];
  }

  // Validate conversation_id if provided
  let conversationId: string | null = null;
  if (body.conversation_id !== undefined) {
    if (typeof body.conversation_id !== "string") {
      return validationError("Validation failed", [
        { field: "conversation_id", message: "conversation_id must be a string UUID" },
      ]);
    }
    conversationId = body.conversation_id;
  }

  const db = createAdminClient();

  // Resolve or create the conversation
  if (conversationId) {
    // Verify it belongs to this user
    const { data: conv } = await db
      .from("assistant_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", actor.id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();

    if (!conv) {
      // Treat as "not found" — silently create a new one rather than leaking
      conversationId = null;
    }
  }

  if (!conversationId) {
    // Derive title from the first ~6 words of the message
    const title = message.split(/\s+/).slice(0, 6).join(" ");

    const { data: newConv, error: convErr } = await db
      .from("assistant_conversations")
      .insert({
        workspace_id: actor.workspaceId,
        user_id: actor.id,
        title,
      })
      .select("id")
      .single();

    if (convErr || !newConv) {
      throw new Error(`Failed to create conversation: ${convErr?.message ?? "unknown"}`);
    }
    conversationId = newConv.id as string;
  }

  // Persist the user message
  await db.from("assistant_messages").insert({
    conversation_id: conversationId,
    role: "user",
    content: message,
  });

  const origin = new URL(request.url).origin;
  const wantsStream = body.stream === true;

  if (wantsStream) {
    // ── Streaming path ────────────────────────────────────────────────────────
    // Run agentic loop, then stream the final reply as NDJSON events.
    // Governance is unchanged — same ephemeral token lifecycle.
    const capturedConversationId = conversationId;
    const capturedDb = db;

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        function emit(obj: Record<string, unknown>) {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        }

        try {
          const { actions, usedDemoKey, textChunks } = await runAssistantStream({
            actor,
            message,
            history,
            origin,
          });

          // Emit actions event first
          emit({ type: "actions", actions });

          // Stream text tokens
          let fullReply = "";
          for await (const chunk of textChunks) {
            fullReply += chunk;
            emit({ type: "token", text: chunk });
          }

          // Persist assistant reply + actions
          await capturedDb.from("assistant_messages").insert({
            conversation_id: capturedConversationId,
            role: "assistant",
            content: fullReply || "Done.",
            actions: actions.length > 0 ? actions : null,
          });

          // Bump updated_at
          await capturedDb
            .from("assistant_conversations")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", capturedConversationId);

          // Done event
          emit({ type: "done", conversation_id: capturedConversationId, usedDemoKey });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : "Streaming error";
          emit({ type: "error", message: errMessage });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // ── Non-streaming path (unchanged) ───────────────────────────────────────
  const result = await runAssistant({ actor, message, history, origin });

  // Persist the assistant reply + actions
  await db.from("assistant_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: result.reply,
    actions: result.actions.length > 0 ? result.actions : null,
  });

  // Bump updated_at on the conversation
  await db
    .from("assistant_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  return ok({ ...result, conversation_id: conversationId });
});
