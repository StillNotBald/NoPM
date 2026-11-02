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
 * On any error during streaming, a SANITIZED { type: "error", message: string, conversation_id }
 * (the id lets the panel's Retry reuse the conversation) is emitted — never the raw provider/upstream error text.
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
 * or usedFallback is true, else 'false'. If the failed turn had already run
 * tools, the fallback reply lists those actions (D-ACC-8).
 *
 * Demo quota (D-ACC-10, A1-12): charged once per user turn, per client address
 * and globally, fail-closed. An exhausted quota answers 429 with Retry-After; a
 * broken counter store answers 503.
 */

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { ApiError, ScopeError } from "@/lib/api/errors";
import { ipRateKey } from "@/lib/api/client-ip";
import { resolveInternalOrigin } from "@/lib/api/internal-origin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import {
  runAssistant,
  runAssistantStream,
  resolveProvider,
  chargeTurnQuota,
  hasOwnCredential,
  refundTurnQuota,
  newTurnQuota,
  DemoQuotaExceededError,
  type Action,
  type AssistantResult,
  type ResolvedProvider,
} from "@/lib/assistant/index";
import { runAssistantFallback, priorActionsNote, type FallbackResult } from "@/lib/assistant/fallback";
import { ProviderError, providerErrorInfo, type ProviderErrorInfo } from "@/lib/assistant/providers/errors";
import { resolvePageContext } from "@/lib/assistant/page-context";
import {
  MAX_MESSAGE_CHARS,
  MAX_STORED_HISTORY,
  boundClientHistory,
  interruptedContent,
  priorAttemptNote,
  rowsToHistory,
  splitRetry,
  type HistoryRow,
} from "@/lib/assistant/history";
import { isDemoActor } from "@/lib/auth/demo";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A2: no provider failure is swallowed. A typed ProviderError is logged with
 * kind + provider + HTTP status only (never the upstream body, never a key) and
 * returned as the additive `provider_error` field so the panel can say what
 * happened. Any other failure is logged by name only and gets no provider_error.
 */
function noteTurnError(err: unknown, mode: "json" | "stream"): ProviderErrorInfo | null {
  if (err instanceof ProviderError) {
    console.error("[nopm][assistant] provider error", {
      kind: err.kind,
      provider: err.provider,
      status: err.status,
      mode,
    });
    return providerErrorInfo(err);
  }
  console.error("[nopm][assistant] turn failed", { error: err instanceof Error ? err.name : "unknown", mode });
  return null;
}

const MID_STREAM_ERROR_MESSAGE = "The assistant hit a problem mid-reply. Please try again.";

/** HTTP 429 for an exhausted demo quota, with the Retry-After the client should honour. */
function quotaExceededResponse(err: DemoQuotaExceededError): Response {
  return NextResponse.json(
    { error: err.message, code: err.code ?? "rate_limited" },
    { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds) } },
  );
}

/**
 * Run the grounded fallback. If it is refused by the demo quota AFTER the failed
 * turn already executed tools, the user still gets the list of what was done
 * (those actions are real and audited) instead of an error that hides them.
 */
async function answerWithFallback(
  fallbackOpts: Parameters<typeof runAssistantFallback>[0],
  prior: Action[],
): Promise<FallbackResult> {
  try {
    return await runAssistantFallback({ ...fallbackOpts, priorActions: prior });
  } catch (err) {
    if (prior.length > 0 && err instanceof ApiError) {
      return { reply: priorActionsNote(prior), actions: prior, usedFallback: true, usedDemoKey: false };
    }
    throw err;
  }
}

/**
 * Record a turn that stopped early (A3/A9): an assistant row "(interrupted) ..." that keeps the
 * partial text and the actions already run, so a reload shows what really happened and a retry
 * knows not to repeat it. Writes nothing when the turn had done nothing. Never throws.
 */
async function saveInterrupted(
  db: ReturnType<typeof createAdminClient>,
  conversationId: string | null,
  actionLog: Action[],
  partialReply: string,
): Promise<void> {
  if (!conversationId) return;
  const content = interruptedContent(actionLog, partialReply);
  if (!content) return;
  try {
    await db.from("assistant_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content,
      actions: actionLog.length > 0 ? actionLog : null,
    });
    await db.from("assistant_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  } catch {
    console.error("[nopm][assistant] could not record an interrupted turn");
  }
}

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
    context?: unknown;
    retry?: unknown;
  }>(request);

  if (!body || typeof body.message !== "string" || body.message.trim() === "") {
    return validationError("Validation failed", [
      { field: "message", message: "message is required and must be a non-empty string" },
    ]);
  }

  const message = body.message.trim();
  if (message.length > MAX_MESSAGE_CHARS) {
    return validationError("Validation failed", [
      { field: "message", message: `message must be at most ${MAX_MESSAGE_CHARS} characters` },
    ]);
  }
  const isRetry = body.retry === true;

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

  // The assistant sends its ephemeral bearer token to this origin, so it must be
  // the operator's configured app URL, never the Host-derived request origin
  // (A1-11; same rule as /api/mcp). Fail closed when none can be trusted.
  const origin = resolveInternalOrigin(request);
  if (!origin) {
    console.error(
      "[nopm][assistant] NEXT_PUBLIC_APP_URL is not set in production, so the assistant refuses rather than sending its token to a Host-derived origin",
    );
    throw new ApiError(
      503,
      "The assistant is not configured: the operator must set NEXT_PUBLIC_APP_URL to this app's public URL.",
      "misconfigured",
    );
  }

  const db = createAdminClient();
  const demo = await isDemoActor(actor);

  // Demo-key quota: charged ONCE per user turn (provider resolution charges it,
  // the fallback's check is then a no-op). Resolved BEFORE anything is persisted
  // so a refused turn leaves no orphan conversation or message behind.
  const quota = newTurnQuota(ipRateKey(request.headers));
  let resolved: ResolvedProvider | null = null;
  try {
    resolved = await resolveProvider(actor, quota);
  } catch (err) {
    if (err instanceof DemoQuotaExceededError) return quotaExceededResponse(err);
    if (err instanceof ApiError) throw err; // quota store down -> 503, fail closed
    // No credentials / unreadable key: the grounded fallback answers. Logged by
    // error name only (never the message), so a broken stored key is visible.
    console.error("[nopm][assistant] provider not resolved", { error: err instanceof Error ? err.name : "unknown" });
    resolved = null;
  }
  // Someone on their OWN key whose provider failed is answered by the fallback without touching the shared demo allowance.
  const ownKey = resolved ? !resolved.usedDemoKey : await hasOwnCredential(db, actor.id);
  const rateCheck = ownKey ? async () => {} : () => chargeTurnQuota(db, actor.id, quota);
  if (!resolved && !ownKey) {
    // Straight to the fallback, which charges the demo quota. Do that now so an
    // exhausted quota is a real 429 (not an error event inside a 200 stream).
    try {
      await rateCheck();
    } catch (err) {
      if (err instanceof DemoQuotaExceededError) return quotaExceededResponse(err);
      throw err;
    }
  }

  // Resolve or create the conversation — demo actors NEVER persist (fresh
  // chat every visit, no cross-visit history, no migration). BYOK/non-demo
  // users are completely unchanged.
  let conversationId: string | null = demo ? null : ((body.conversation_id as string | undefined) ?? null);
  // A4/A3: for a conversation that already exists the stored rows are the history (the client's
  // copy can be forged or stale); a retry also learns what its first attempt already did.
  let storedRows: HistoryRow[] | null = null;
  let priorAttempt: string | null = null;
  let userRowAlreadyStored = false;

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
      } else {
        const { data: rows, error: rowsErr } = await db
          .from("assistant_messages")
          .select("role, content, actions")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .limit(MAX_STORED_HISTORY + 2);
        if (!rowsErr && rows) {
          let list = (rows as HistoryRow[]).filter((r) => r.role === "user" || r.role === "assistant").reverse();
          if (isRetry) {
            const split = splitRetry(list, message);
            list = split.rows;
            priorAttempt = priorAttemptNote(split.priorActions);
            userRowAlreadyStored = split.dropUserRow;
          }
          storedRows = list;
        }
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

    // Persist the user message. A failed insert fails the turn BEFORE any tool runs (A9),
    // so no write can happen for a message that was never recorded. A retry whose first
    // attempt already stored this exact message does not store it twice.
    if (!userRowAlreadyStored) {
      const { error: msgErr } = await db.from("assistant_messages").insert({
        conversation_id: conversationId,
        role: "user",
        content: message,
      });
      if (msgErr) {
        console.error("[nopm][assistant] could not store the user message", { code: msgErr.code ?? "unknown" });
        throw new ApiError(500, "Could not save your message. Please try again.", "persist_failed");
      }
    }
  }

  // The history the model sees: stored rows when the conversation exists, else the client's
  // (demo sessions and brand-new conversations only), bounded per entry.
  const turnHistory = storedRows ? rowsToHistory(storedRows) : boundClientHistory(history);

  // Where the person is (A5): validated, workspace-checked, best effort.
  const pageContext = await resolvePageContext(body.context, actor.workspaceId, db);

  const wantsStream = body.stream === true;
  // Forward the caller's own X-Request-Id (if any) into the assistant's
  // internal tool-call fetches so those audit_log rows correlate back to
  // this chat request rather than each minting its own id (R-82).
  const requestId = actor.requestId;
  // Every action the turn executes lands here as it runs, so a provider failure
  // after tools ran can still report them (D-ACC-8).
  const actionLog: Action[] = [];

  if (wantsStream) {
    // ── Streaming path ────────────────────────────────────────────────────────
    const capturedConversationId = conversationId;
    const capturedDb = db;
    const capturedDemo = demo;

    // The ephemeral token is revoked on EVERY exit (A1-10): the stream's own
    // generator only revokes once iteration starts, so a client that goes away
    // first (cancel), an error, or a timeout would otherwise leave it alive.
    let cancelled = false;
    let release: (() => Promise<void>) | null = null;

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        function emit(obj: Record<string, unknown>) {
          try {
            controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
          } catch {
            // The reader is gone (cancelled): stop producing, keep cleaning up.
            cancelled = true;
          }
        }

        let tokensFlushed = false;
        // Declared outside the try so the finally can still record an interrupted turn (A3/A9).
        let fullReply = "";
        let normalPersisted = false;

        try {
          let actions: Action[] = [];
          let usedDemoKey = false;
          let usedFallback = false;
          let midStreamFailure = false;
          let providerError: ProviderErrorInfo | null = null;

          try {
            if (!resolved) throw new Error("no provider configured");
            const stream = await runAssistantStream({
              actor,
              message,
              history: turnHistory,
              origin,
              requestId,
              conversationId: capturedConversationId,
              actionLog,
              quota,
              resolved,
              pageContext,
              priorAttempt,
            });
            release = stream.release;
            if (cancelled) return; // finally revokes
            actions = stream.actions;
            usedDemoKey = stream.usedDemoKey;

            // Emit actions event first
            emit({ type: "actions", actions });

            // Stream text tokens
            for await (const chunk of stream.textChunks) {
              if (cancelled) break; // leaving the loop runs the generator's finally
              tokensFlushed = true;
              fullReply += chunk;
              emit({ type: "token", text: chunk });
            }
            if (cancelled) return;
          } catch (turnErr) {
            providerError = noteTurnError(turnErr, "stream");
            if (tokensFlushed) {
              // Mid-stream failure AFTER tokens already flushed — never
              // splice fallback text onto a partial reply. Sanitized error
              // only; the client shows a retry affordance.
              midStreamFailure = true;
            } else {
              // Failure BEFORE any token was emitted — run the grounded,
              // rate-limited fallback and emit its reply as normal
              // token/done events into the still-open stream. The actions the
              // failed turn already ran stay in the result (D-ACC-8).
              const fallbackResult = await answerWithFallback(
                {
                  actor,
                  message,
                  origin,
                  rateCheck,
                  requestId,
                  conversationId: capturedConversationId,
                },
                [...actionLog],
              );
              actions = fallbackResult.actions;
              usedDemoKey = fallbackResult.usedDemoKey;
              fullReply = fallbackResult.reply;
              usedFallback = true;
              if (resolved?.usedDemoKey) await refundTurnQuota(capturedDb, actor.id, quota);

              emit({ type: "actions", actions });
              emit({ type: "token", text: fullReply });
            }
          }

          if (midStreamFailure) {
            emit({
              type: "error",
              message: providerError?.message ?? MID_STREAM_ERROR_MESSAGE,
              conversation_id: capturedConversationId,
              ...(providerError ? { provider_error: providerError } : {}),
            });
            return; // outer finally closes the stream
          }

          // Persist assistant reply + actions — skipped entirely for demo
          // actors (fresh chat, no persistence).
          if (!capturedDemo) {
            const { error: saveErr } = await capturedDb.from("assistant_messages").insert({
              conversation_id: capturedConversationId,
              role: "assistant",
              content: fullReply || "Done.",
              actions: actions.length > 0 ? actions : null,
            });
            if (saveErr) {
              // Not saved: the finally below records an (interrupted) row instead, so the actions survive a reload.
              console.error("[nopm][assistant] could not store the reply", { code: saveErr.code ?? "unknown" });
            } else {
              normalPersisted = true;
            }

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
            ...(providerError ? { provider_error: providerError } : {}),
          });
        } catch (err) {
          // Catch-all safety net (e.g. the fallback itself being refused). Never
          // leak raw error text. A spent demo quota is named (the 200 stream is
          // already open, so it travels as an error event with the same code).
          if (err instanceof DemoQuotaExceededError) {
            emit({
              type: "error",
              code: "rate_limited",
              retry_after_seconds: err.retryAfterSeconds,
              message: err.message,
              conversation_id: capturedConversationId,
            });
          } else {
            emit({ type: "error", message: MID_STREAM_ERROR_MESSAGE, conversation_id: capturedConversationId });
          }
        } finally {
          // A turn that stopped early (provider error after tokens, client cancel, fallback refused)
          // but had already run tools or sent text keeps its action record (A3/A9).
          if (!normalPersisted && !capturedDemo) {
            await saveInterrupted(capturedDb, capturedConversationId, actionLog, fullReply);
          }
          const r: (() => Promise<void>) | null = release;
          if (r) await r().catch(() => {});
          try {
            controller.close();
          } catch {
            /* already closed by a cancel */
          }
        }
      },
      async cancel() {
        cancelled = true;
        const r: (() => Promise<void>) | null = release;
        if (r) await r().catch(() => {});
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
  let providerError: ProviderErrorInfo | null = null;
  try {
    if (!resolved) throw new Error("no provider configured");
    result = await runAssistant({ actor, message, history: turnHistory, origin, requestId, conversationId, actionLog, quota, resolved, pageContext, priorAttempt });
  } catch (turnErr) {
    providerError = noteTurnError(turnErr, "json");
    // Never surface the raw provider/upstream error to the client — answer
    // with the grounded, rate-limited fallback instead, keeping the list of
    // anything the failed turn had already done.
    try {
      result = await answerWithFallback(
        { actor, message, origin, rateCheck, requestId, conversationId },
        [...actionLog],
      );
    } catch (err) {
      if (!demo) await saveInterrupted(db, conversationId, actionLog, "");
      if (err instanceof DemoQuotaExceededError) return quotaExceededResponse(err);
      throw err;
    }
    usedFallback = true;
    if (resolved?.usedDemoKey) await refundTurnQuota(db, actor.id, quota);
  }

  if (!demo) {
    // Persist the assistant reply + actions — identical treatment whether
    // the reply came from the real provider or the fallback.
    const { error: saveErr } = await db.from("assistant_messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: result.reply,
      actions: result.actions.length > 0 ? result.actions : null,
    });
    if (saveErr) {
      console.error("[nopm][assistant] could not store the reply", { code: saveErr.code ?? "unknown" });
      await saveInterrupted(db, conversationId, result.actions, result.reply);
    }

    // Bump updated_at on the conversation
    await db
      .from("assistant_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  }

  const demoModeHeader = result.usedDemoKey || usedFallback ? "true" : "false";

  return ok(
    { ...result, conversation_id: conversationId, ...(providerError ? { provider_error: providerError } : {}) },
    { headers: { "X-Demo-Mode": demoModeHeader } },
  );
});
