/**
 * POST /api/assistant/chat
 * Session-user only (not token actors).
 * Runs the agentic assistant loop and returns { reply, actions, usedDemoKey }.
 */

export const runtime = "nodejs";

import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { runAssistant } from "@/lib/assistant/index";

export const POST = route(async ({ actor, request }) => {
  // Session-user only — token actors are rejected
  if (actor.type !== "user") {
    throw new ScopeError("AI assistant is only available to human sessions");
  }

  const body = await safeJson<{
    message?: unknown;
    history?: unknown;
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

  const origin = new URL(request.url).origin;

  const result = await runAssistant({ actor, message, history, origin });

  return ok(result);
});
