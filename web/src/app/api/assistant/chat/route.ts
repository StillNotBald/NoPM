/**
 * POST /api/assistant/chat
 * Session-user only (not token actors).
 * Runs the agentic assistant loop, persists the conversation, and returns
 * { reply, actions, usedDemoKey, conversation_id }.
 *
 * When body.stream === true the response is a ReadableStream of NDJSON events:
 *   { type: "actions",  actions: Action[] }
 *   { type: "token",    text: string }      (one or more)
 *   { type: "done",     conversation_id: string | null, usedDemoKey: boolean }
 * On any error during streaming, a SANITIZED { type: "error", message: string }
 * is emitted — never the raw provider/upstream error text.
 * The non-stream JSON path is byte-for-byte unchanged for BYOK/non-demo users.
 *
 * Demo actors (the shared, publicly-reachable demo login — see
 * src/lib/auth/demo.ts) get a fresh chat every visit: no conversation is
 * ever created or loaded, no messages are persisted, and conversation_id is
 * always null in the response. BYOK/non-demo users are completely
 * unchanged.
 *
 * If the real provider call fails (no credentials, demo key exhausted,
 * upstream capacity/rate-limit, transient network error), a grounded,
 * rate-limited, read-only fallback answers instead — see
 * src/lib/assistant/fallback.ts. X-Demo-Mode is 'true' whenever usedDemoKey
 * or usedFallback is true, else 'false'.
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { runAssistant, runAssistantStream, checkDemoRateLimit, type Action, type AssistantResult } from "@/lib/assistant/index";
import { runAssistantFallback, type FallbackResult } from "@/lib/assistant/fallback";
import { isDemoActor } from "@/lib/auth/demo";
import { createAdminClient } from "@/lib/supabase/admin";

const MID_STREAM_ERROR_MESSAGE = "The assistant hit a problem mid-reply. Please try again.";

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

  // Validate conversation_id shape if provided (format only — demo actors
  // ignore its value entirely, see below).
  if (body.conversation_id !== undefined && typeof body.conversation_id !== "string") {
    return validationError("Validation failed", [
      { field: "conversation_id", message: "conversation_id must be a string UUID" },
    ]);
  }

  const db = createAdminClient();
  const demo = await isDemoActor(actor);

  // Resolve or create the conversation — demo actors NEVER persist (fresh
  // chat every visit, no cross-visit history, no migration). BYOK/non-demo
  // users are completely unchanged.
  let conversationId: string | null = demo ? null : ((body.conversation_id as string | undefined) ?? null);

  if (!demo) {
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
  }

  const origin = new URL(request.url).origin;
  const wantsStream = body.stream === true;
  const rateCheck = () => checkDemoRateLimit(db, actor.id);

  if (wantsStream) {
    // ── Streaming path ────────────────────────────────────────────────────────
    const capturedConversationId = conversationId;
    const capturedDb = db;
    const capturedDemo = demo;

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        function emit(obj: Record<string, unknown>) {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        }

        let tokensFlushed = false;

        try {
          let actions: Action[] = [];
          let usedDemoKey = false;
          let usedFallback = false;
          let fullReply = "";
          let midStreamFailure = false;

          try {
            const { actions: streamActions, usedDemoKey: streamUsedDemoKey, textChunks } =
              await runAssistantStream({ actor, message, history, origin });
            actions = streamActions;
            usedDemoKey = streamUsedDemoKey;

            // Emit actions event first
            emit({ type: "actions", actions });

            // Stream text tokens
            for await (const chunk of textChunks) {
              tokensFlushed = true;
              fullReply += chunk;
              emit({ type: "token", text: chunk });
            }
          } catch {
            if (tokensFlushed) {
              // Mid-stream failure AFTER tokens already flushed — never
              // splice fallback text onto a partial reply. Sanitized error
              // only; the client shows a retry affordance.
              midStreamFailure = true;
            } else {
              // Failure BEFORE any token was emitted — run the grounded,
              // rate-limited fallback and emit its reply as normal
              // token/done events into the still-open stream.
              const fallbackResult = await runAssistantFallback({
                actor,
                message,
                origin,
                rateCheck,
              });
              actions = fallbackResult.actions;
              usedDemoKey = fallbackResult.usedDemoKey;
              fullReply = fallbackResult.reply;
              usedFallback = true;

              emit({ type: "actions", actions });
              emit({ type: "token", text: fullReply });
            }
          }

          if (midStreamFailure) {
            emit({ type: "error", message: MID_STREAM_ERROR_MESSAGE });
            return; // outer finally closes the stream
          }

          // Persist assistant reply + actions — skipped entirely for demo
          // actors (fresh chat, no persistence).
          if (!capturedDemo) {
            await capturedDb.from("assistant_messages").insert({
              conversation_id: capturedConversationId,
              role: "assistant",
              content: fullReply || "Done.",
              actions: actions.length > 0 ? actions : null,
            });

            await capturedDb
              .from("assistant_conversations")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", capturedConversationId);
          }

          // Done event. usedDemoKey keeps its original meaning (a real demo-
          // key provider call was used); usedFallback is a NEW additive
          // field (LOCKED: streaming stays backward-compatible, additive
          // fields only) so older clients that only look at usedDemoKey
          // still work, while updated clients can distinguish "demo key"
          // from "grounded fallback" — both cases where the reply isn't
          // from the user's own configured provider.
          emit({
            type: "done",
            conversation_id: capturedConversationId,
            usedDemoKey,
            usedFallback,
          });
        } catch {
          // Catch-all safety net (e.g. the fallback itself failing — a
          // truly-exhausted rate limit propagates here). Never leak raw
          // error text.
          emit({ type: "error", message: MID_STREAM_ERROR_MESSAGE });
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

  // ── Non-streaming path ───────────────────────────────────────────────────
  let result: AssistantResult | FallbackResult;
  let usedFallback = false;
  try {
    result = await runAssistant({ actor, message, history, origin });
  } catch {
    // Never surface the raw provider/upstream error to the client — answer
    // with the grounded, rate-limited fallback instead.
    result = await runAssistantFallback({ actor, message, origin, rateCheck });
    usedFallback = true;
  }

  if (!demo) {
    // Persist the assistant reply + actions — identical treatment whether
    // the reply came from the real provider or the fallback.
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
  }

  const demoModeHeader = result.usedDemoKey || usedFallback ? "true" : "false";

  return ok(
    { ...result, conversation_id: conversationId },
    { headers: { "X-Demo-Mode": demoModeHeader } },
  );
});
