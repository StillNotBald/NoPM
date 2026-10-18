/**
 * NoPM Assistant — agentic loop.
 * Resolves credentials, mints an ephemeral token, runs tool calls
 * through the real NoPM API, and returns { reply, actions, usedDemoKey }.
 */

export const runtime = "nodejs";

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import type { Actor } from "@/lib/auth/guard";
import { ApiError, RateLimitError } from "@/lib/api/errors";
import { chat, chatStream, type Provider, type ProviderMessage } from "./providers/index";
import { TOOLS } from "./tools";
import { mintEphemeralToken, revokeEphemeralToken } from "./token";

/** A single governed action the assistant took. */
export type Action = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  href?: string;
  auditId?: string;
};

export type AssistantResult = {
  reply: string;
  actions: Action[];
  usedDemoKey: boolean;
};

/**
 * Build the HTTP call for a tool WITHOUT ever throwing. The registry refuses
 * arguments that cannot be placed in a request path safely (a non-UUID id, a
 * path-splicing value: ToolArgError from mcp/tools.mjs). Model output is
 * untrusted, so that refusal must reach the model as an ordinary failed tool
 * result it can correct, never abort the whole turn (the `finally` would revoke
 * the token, but the user would lose the reply and every earlier action).
 */
export function buildToolCall(
  spec: (typeof TOOLS)[number],
  args: Record<string, unknown>,
): { ok: true; path: string; method: string; body?: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, ...spec.toRequest(args) };
  } catch (err) {
    return { ok: false, message: `Bad arguments: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const DEMO_LIMIT = 20;
const DEMO_WINDOW_SECS = 60 * 60; // 1 hour

/** Hard cap on how many messages of forwarded history are sent to the provider. */
export const MAX_HISTORY_MESSAGES = 24;

/** Hard cap on how many tool calls the assistant may EXECUTE within one turn. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

const TOOL_CAP_NOTE =
  "I've reached the limit of tool actions I can take in a single turn " +
  `(${MAX_TOOL_CALLS_PER_TURN}). Here's what I completed — ask me to continue if you'd like more.`;

/** Keep only the last N history messages before forwarding to the provider. */
export function boundHistory<T>(history: T[]): T[] {
  return history.length > MAX_HISTORY_MESSAGES ? history.slice(-MAX_HISTORY_MESSAGES) : history;
}

/** Per-client-address cap on demo-key turns, on top of the shared per-user cap (A1-12). */
const DEMO_IP_LIMIT = 8;

/** The demo cap is spent (HTTP 429 + Retry-After). Thrown, never a generic 500 or a mid-reply error. */
export class DemoQuotaExceededError extends RateLimitError {
  constructor(
    public readonly retryAfterSeconds: number,
    message = "The shared demo limit is used up. Add your own key in Settings.",
  ) {
    super(message);
  }
}

/** The counter store failed: the demo cap fails CLOSED (HTTP 503), never open. */
export class DemoQuotaUnavailableError extends ApiError {
  constructor() {
    super(503, "The demo assistant is unavailable right now. Please try again shortly.", "demo_quota_unavailable");
  }
}

/** Seconds until the shared per-user demo window resets (best effort; the full window if unknown). */
async function demoWindowRetrySeconds(db: ReturnType<typeof createAdminClient>, userId: string): Promise<number> {
  try {
    const { data } = await db.from("assistant_demo_usage").select("window_start").eq("user_id", userId).maybeSingle();
    const start = data?.window_start ? new Date(data.window_start as string).getTime() : NaN;
    if (Number.isFinite(start)) {
      return Math.max(1, Math.min(DEMO_WINDOW_SECS, DEMO_WINDOW_SECS - Math.floor((Date.now() - start) / 1000)));
    }
  } catch {
    /* fall through */
  }
  return DEMO_WINDOW_SECS;
}

/**
 * Durable demo-key rate limit, FAIL-CLOSED (A1-12). Two buckets, both held in
 * service-role-only tables so the cap survives serverless instances and cold
 * starts:
 *  - per client address (`ipKey`, from lib/api/client-ip.ts) so one visitor
 *    cannot spend everyone's quota; skipped only when no address can be trusted;
 *  - per user (nopm_demo_rate_check), which for the shared demo login is the
 *    global cap.
 * A counter-store error refuses the call (503): the cap is cost protection for
 * the maintainer's key, and "the counter is down" must not mean "unlimited".
 * Exported so the chat route can pass it into the fallback's `rateCheck`.
 */
export async function checkDemoRateLimit(
  db: ReturnType<typeof createAdminClient>,
  userId: string,
  opts: { ipKey?: string | null } = {},
): Promise<void> {
  if (opts.ipKey) {
    const { data, error } = await db.rpc("nopm_rate_check", {
      p_key: `assistant-demo:ip:${opts.ipKey}`,
      p_max: DEMO_IP_LIMIT,
      p_window_seconds: DEMO_WINDOW_SECS,
    });
    if (error) {
      console.error("[nopm][assistant] demo per-address rate-limit RPC failed - FAILING CLOSED", {
        rpc: "nopm_rate_check",
        error: error.message,
        at: new Date().toISOString(),
      });
      throw new DemoQuotaUnavailableError();
    }
    const rate = data as { allowed?: boolean; retry_after_seconds?: number } | null;
    if (!rate || rate.allowed !== true) {
      throw new DemoQuotaExceededError(Math.max(1, rate?.retry_after_seconds ?? DEMO_WINDOW_SECS));
    }
  }

  const { data, error } = await db.rpc("nopm_demo_rate_check", {
    p_user: userId,
    p_limit: DEMO_LIMIT,
    p_window_secs: DEMO_WINDOW_SECS,
  });
  if (error) {
    console.error("[nopm][assistant] demo rate-limit RPC failed - FAILING CLOSED", {
      userId,
      rpc: "nopm_demo_rate_check",
      error: error.message,
      at: new Date().toISOString(),
    });
    throw new DemoQuotaUnavailableError();
  }
  if (data === false) {
    throw new DemoQuotaExceededError(await demoWindowRetrySeconds(db, userId));
  }
}

/**
 * Per-turn quota state: the demo counter is charged AT MOST ONCE per user turn
 * (D-ACC-10). Provider resolution charges it; if the real provider then fails
 * and the grounded fallback answers, the fallback's check is a no-op instead of
 * a second charge.
 */
export type TurnQuota = { ipKey: string | null; charged: boolean; refunded?: boolean };

export function newTurnQuota(ipKey: string | null = null): TurnQuota {
  return { ipKey, charged: false };
}

export async function chargeTurnQuota(
  db: ReturnType<typeof createAdminClient>,
  userId: string,
  quota: TurnQuota,
): Promise<void> {
  if (quota.charged) return;
  await checkDemoRateLimit(db, userId, { ipKey: quota.ipKey });
  quota.charged = true;
}

/**
 * A demo-key turn whose provider call FAILED (the grounded fallback answered
 * instead) does not count against the shared demo allowance (Q-ACC-10): give the
 * per-user unit back. At most once per turn; fail-soft, because a refund that
 * cannot be written must never turn an answered turn into an error.
 */
export async function refundTurnQuota(
  db: ReturnType<typeof createAdminClient>,
  userId: string,
  quota: TurnQuota,
): Promise<void> {
  if (!quota.charged || quota.refunded) return;
  quota.refunded = true;
  try {
    const { error } = await db.rpc("nopm_demo_rate_refund", { p_user: userId });
    if (error) console.error("[nopm][assistant] demo quota refund failed", { error: error.message });
  } catch (err) {
    console.error("[nopm][assistant] demo quota refund threw", { error: err instanceof Error ? err.message : "unknown" });
  }
}

/**
 * Does this user have their own provider key saved? A person on their own key
 * who hits a provider error must never be billed to the shared demo allowance
 * (Q-ACC-10): the grounded fallback calls no provider, so it costs nothing.
 */
export async function hasOwnCredential(db: ReturnType<typeof createAdminClient>, userId: string): Promise<boolean> {
  try {
    const { data } = await db.from("assistant_credentials").select("id").eq("user_id", userId).maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Resolve the LLM provider+key+model for this user. */
export type ResolvedProvider = {
  provider: Provider;
  apiKey: string;
  model: string;
  usedDemoKey: boolean;
};

export async function resolveProvider(actor: Actor, quota: TurnQuota = newTurnQuota()): Promise<ResolvedProvider> {
  const db = createAdminClient();
  const { data: cred } = await db
    .from("assistant_credentials")
    .select("provider, api_key_enc, model")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (cred) {
    const apiKey = decrypt(cred.api_key_enc);
    return {
      provider: cred.provider as Provider,
      apiKey,
      model: cred.model,
      usedDemoKey: false,
    };
  }

  // Fallback to demo env
  const demoProvider = (process.env.NOPM_DEMO_LLM_PROVIDER ?? "openai") as Provider;
  const demoKey = process.env.NOPM_DEMO_LLM_KEY ?? "";
  const demoModel = process.env.NOPM_DEMO_LLM_MODEL ?? "gpt-4o-mini";

  if (!demoKey) {
    throw new Error(
      "No AI assistant credentials configured and no demo key available. " +
      "Please add your API key in Settings > AI Assistant."
    );
  }

  await chargeTurnQuota(db, actor.id, quota);

  return { provider: demoProvider, apiKey: demoKey, model: demoModel, usedDemoKey: true };
}

/** Build a human-readable summary from a tool name + result. */
function summarize(toolName: string, args: Record<string, unknown>, result: unknown, ok: boolean): string {
  const r = result as Record<string, unknown> | null;
  if (!ok) {
    const errMsg = (r?.error as string) ?? "unknown error";
    return `${toolName} failed: ${errMsg}`;
  }
  const data = r?.data as Record<string, unknown> | null;
  switch (toolName) {
    case "list_projects": return `Listed ${(r?.total as number | undefined) ?? "?"} projects`;
    case "create_project": return `Created project "${(data?.name as string) ?? ""}"`;
    case "list_milestones": return `Listed ${(r?.total as number | undefined) ?? "?"} milestones`;
    case "create_milestone": return `Created milestone "${(data?.name as string) ?? ""}"`;
    case "list_tasks": return `Listed ${(r?.total as number | undefined) ?? "?"} tasks`;
    case "create_task": return `Created task "${(data?.name as string) ?? ""}"`;
    case "request_task_deletion": return `Requested deletion of task (pending approval)`;
    case "list_risks": return `Listed ${(r?.total as number | undefined) ?? "?"} risks`;
    case "create_risk": return `Created risk "${(data?.title as string) ?? ""}"`;
    case "list_issues": return `Listed ${(r?.total as number | undefined) ?? "?"} issues`;
    case "create_issue": return `Created issue "${(data?.title as string) ?? ""}"`;
    case "get_budget": return `Retrieved budget data`;
    case "list_clashes": return `Listed ${(r?.total as number | undefined) ?? "?"} clashes`;
    case "list_resources": return `Listed ${(r?.total as number | undefined) ?? "?"} resources`;
    case "query_audit": return `Found ${(r?.total as number | undefined) ?? "?"} audit entries`;
    case "list_pending_approvals": {
      // No "M you can decide" count on purpose: the ephemeral token never holds an
      // approve/decide scope, so every item's can_decide is false for the assistant
      // even when the signed-in person may decide it in the console. Say what is
      // verifiably true instead — the total, and whether some kinds were unreadable.
      const total = r?.total as number | undefined;
      const hidden = Array.isArray(r?.hidden_kinds) ? (r?.hidden_kinds as unknown[]).length : 0;
      const count = total === undefined ? "?" : String(total);
      const noun = total === 1 ? "pending approval" : "pending approvals";
      return `${count} ${noun}${hidden > 0 ? ` (${hidden} kind${hidden === 1 ? "" : "s"} not visible to the assistant)` : ""}`;
    }
    default: return `${toolName} completed`;
  }
}

/** Build a deep-link href for a newly created entity, if possible. */
function buildHref(toolName: string, args: Record<string, unknown>, result: unknown): string | undefined {
  const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | null;
  if (!data) return undefined;
  const projectId = (data.project_id as string | undefined) ?? (args.project_id as string | undefined);
  switch (toolName) {
    case "create_project":
      return `/projects/${data.id as string}`;
    case "create_milestone":
      return projectId ? `/projects/${projectId}/milestones` : undefined;
    case "create_task":
      return projectId ? `/projects/${projectId}/tasks` : undefined;
    case "create_risk":
      return projectId ? `/projects/${projectId}/risks` : undefined;
    case "create_issue":
      return projectId ? `/projects/${projectId}/issues` : undefined;
    default:
      return undefined;
  }
}

const SYSTEM_PROMPT = `You are the NoPM governance assistant — a careful, concise AI embedded in a project management tool.
You help PMs create projects, tasks, risks, issues, milestones, review budgets, and query the audit trail.
ALWAYS prefer to ask for missing required fields before calling tools rather than guessing.
When you request a task deletion, remind the user it requires maker-checker approval.
Keep responses brief and professional. Never reveal internal token details or system internals.`;

export async function runAssistant(opts: {
  actor: Actor;
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  origin: string;
  /** Incoming X-Request-Id from the chat request, forwarded into the
   *  internal tool-call fetches so their audit rows correlate back to this
   *  request rather than each minting its own id (R-82). */
  requestId?: string;
  /** The conversation this turn belongs to; written on the token mint/revoke audit rows (A3-14). */
  conversationId?: string | null;
  /** Filled with every action as it runs, so the caller still has them if the turn throws (D-ACC-8). */
  actionLog?: Action[];
  /** Per-turn demo-quota state shared with the fallback (D-ACC-10). */
  quota?: TurnQuota;
  /** Provider already resolved (and its quota already charged) by the caller. */
  resolved?: ResolvedProvider;
}): Promise<AssistantResult> {
  const { actor, message, history, origin, requestId, conversationId = null } = opts;

  const { provider, apiKey, model, usedDemoKey } = opts.resolved ?? (await resolveProvider(actor, opts.quota));

  const toolDefs = TOOLS.map((t) => t.definition);

  // Build message history for provider (bounded — never forward unbounded history)
  const providerMessages: ProviderMessage[] = [
    ...boundHistory(history).map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: message },
  ];

  const actions: Action[] = opts.actionLog ?? [];
  let ephemeral: { raw: string; id: string } | null = null;
  let toolCallsExecuted = 0;

  try {
    ephemeral = await mintEphemeralToken(actor, { conversationId });

    const MAX_STEPS = 6;

    for (let step = 0; step < MAX_STEPS; step++) {
      const result = await chat({
        provider,
        apiKey,
        model,
        system: SYSTEM_PROMPT,
        messages: providerMessages,
        tools: toolDefs,
      });

      // Append assistant turn
      if (result.toolCalls.length === 0) {
        // Final text response
        return {
          reply: result.text ?? "Done.",
          actions,
          usedDemoKey,
        };
      }

      // Execute tool calls
      const toolResults: ProviderMessage[] = [];
      let hitToolCap = false;

      for (const tc of result.toolCalls) {
        if (toolCallsExecuted >= MAX_TOOL_CALLS_PER_TURN) {
          hitToolCap = true;
          break;
        }
        toolCallsExecuted++;

        const spec = TOOLS.find((t) => t.definition.name === tc.name);
        if (!spec) {
          const errorContent = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
          toolResults.push({
            role: "tool",
            content: errorContent,
            tool_call_id: tc.id,
          });
          actions.push({
            tool: tc.name,
            args: tc.args,
            ok: false,
            summary: `Unknown tool: ${tc.name}`,
          });
          continue;
        }

        const built = buildToolCall(spec, tc.args);
        if (!built.ok) {
          toolResults.push({ role: "tool", content: JSON.stringify({ error: built.message }), tool_call_id: tc.id });
          actions.push({ tool: tc.name, args: tc.args, ok: false, summary: built.message });
          continue;
        }
        const { path, method, body } = built;
        const url = `${origin}${path}`;

        let responseData: unknown = null;
        let ok = false;
        let status = 0;

        try {
          const fetchOpts: RequestInit = {
            method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${ephemeral.raw}`,
              "X-NoPM-Client": "assistant",
              ...(requestId ? { "X-Request-Id": requestId } : {}),
            },
          };
          if (body !== undefined && method !== "GET") {
            fetchOpts.body = JSON.stringify(body);
          }

          const res = await fetch(url, fetchOpts);
          status = res.status;
          const text = await res.text();
          try { responseData = JSON.parse(text); } catch { responseData = { raw: text }; }
          ok = status >= 200 && status < 300;
        } catch (fetchErr) {
          responseData = { error: String(fetchErr) };
          ok = false;
        }

        const summary = summarize(tc.name, tc.args, responseData, ok);
        const href = ok ? buildHref(tc.name, tc.args, responseData) : undefined;
        const auditId = (responseData as Record<string, unknown>)?.auditId as string | undefined;

        actions.push({ tool: tc.name, args: tc.args, ok, summary, href, auditId });

        toolResults.push({
          role: "tool",
          content: JSON.stringify(responseData),
          tool_call_id: tc.id,
        });
      }

      if (hitToolCap) {
        // Per-turn tool-call cap reached mid-batch — stop immediately with a
        // polite note rather than silently truncating the batch and
        // continuing the loop with an inconsistent tool_calls/tool_results
        // pairing.
        return { reply: TOOL_CAP_NOTE, actions, usedDemoKey };
      }

      // Append assistant turn with tool_calls (needed for Anthropic/OpenAI history)
      providerMessages.push({
        role: "assistant",
        content: result.text ?? null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      // Append tool results
      providerMessages.push(...toolResults);
    }

    // Max steps reached — ask the model for a final summary with no tools
    const finalResult = await chat({
      provider,
      apiKey,
      model,
      system: SYSTEM_PROMPT,
      messages: [...providerMessages, {
        role: "user",
        content: "Please summarize what you have done so far.",
      }],
      tools: [], // no tools — force text response
    });

    return {
      reply: finalResult.text ?? "Completed all steps.",
      actions,
      usedDemoKey,
    };
  } finally {
    if (ephemeral) {
      await revokeEphemeralToken(ephemeral.id, { actor, conversationId });
    }
  }
}

/**
 * Streaming variant — runs the full agentic loop (non-streamed tool rounds),
 * then streams only the final assistant text reply via the returned AsyncIterable.
 *
 * Governance is identical: same ephemeral token, same scopes, same audit trail.
 * The caller receives:
 *   - actions:     the Action[] gathered during tool rounds (emit as "actions" event)
 *   - textChunks:  AsyncIterable<string> — stream to the client as "token" events
 *   - usedDemoKey: boolean
 */
export async function runAssistantStream(opts: {
  actor: Actor;
  message: string;
  history: { role: "user" | "assistant"; content: string }[];
  origin: string;
  /** See runAssistant's requestId — same forwarding, streaming variant. */
  requestId?: string;
  /** See runAssistant. */
  conversationId?: string | null;
  actionLog?: Action[];
  quota?: TurnQuota;
  resolved?: ResolvedProvider;
}): Promise<{
  actions: Action[];
  usedDemoKey: boolean;
  textChunks: AsyncIterable<string>;
  /**
   * Revoke the turn's ephemeral token now. Idempotent. The caller MUST call it
   * when it stops consuming `textChunks` for any reason (client gone before
   * iteration, error, timeout): the generator's own `finally` only runs once
   * iteration has started (A1-10).
   */
  release: () => Promise<void>;
}> {
  const { actor, message, history, origin, requestId, conversationId = null } = opts;

  const { provider, apiKey, model, usedDemoKey } = opts.resolved ?? (await resolveProvider(actor, opts.quota));

  const toolDefs = TOOLS.map((t) => t.definition);

  // Bounded — never forward unbounded history to the provider.
  const providerMessages: ProviderMessage[] = [
    ...boundHistory(history).map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: message },
  ];

  const actions: Action[] = opts.actionLog ?? [];
  let ephemeral: { raw: string; id: string } | null = null;
  let toolCallsExecuted = 0;

  // We need to run the full agentic loop (tool rounds) before we can stream.
  // After the loop we either have a final text already (no more tool calls) or
  // we need one more non-tool call to get the text. In either case we then
  // stream that final completion.

  try {
    ephemeral = await mintEphemeralToken(actor, { conversationId });

    const MAX_STEPS = 6;
    let finalMessages: ProviderMessage[] | null = null; // messages to pass into the final stream call
    let immediateText: string | null = null;            // if loop already produced text with no tools

    for (let step = 0; step < MAX_STEPS; step++) {
      const result = await chat({
        provider,
        apiKey,
        model,
        system: SYSTEM_PROMPT,
        messages: providerMessages,
        tools: toolDefs,
      });

      if (result.toolCalls.length === 0) {
        // The model responded with plain text — stream it as-is
        immediateText = result.text;
        finalMessages = null;
        break;
      }

      // Execute tool calls (identical to runAssistant)
      const toolResults: ProviderMessage[] = [];
      let hitToolCap = false;

      for (const tc of result.toolCalls) {
        if (toolCallsExecuted >= MAX_TOOL_CALLS_PER_TURN) {
          hitToolCap = true;
          break;
        }
        toolCallsExecuted++;

        const spec = TOOLS.find((t) => t.definition.name === tc.name);
        if (!spec) {
          const errorContent = JSON.stringify({ error: `Unknown tool: ${tc.name}` });
          toolResults.push({ role: "tool", content: errorContent, tool_call_id: tc.id });
          actions.push({ tool: tc.name, args: tc.args, ok: false, summary: `Unknown tool: ${tc.name}` });
          continue;
        }

        const built = buildToolCall(spec, tc.args);
        if (!built.ok) {
          toolResults.push({ role: "tool", content: JSON.stringify({ error: built.message }), tool_call_id: tc.id });
          actions.push({ tool: tc.name, args: tc.args, ok: false, summary: built.message });
          continue;
        }
        const { path, method, body } = built;
        const url = `${origin}${path}`;

        let responseData: unknown = null;
        let ok = false;
        let status = 0;

        try {
          const fetchOpts: RequestInit = {
            method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${ephemeral.raw}`,
              "X-NoPM-Client": "assistant",
              ...(requestId ? { "X-Request-Id": requestId } : {}),
            },
          };
          if (body !== undefined && method !== "GET") {
            fetchOpts.body = JSON.stringify(body);
          }
          const res = await fetch(url, fetchOpts);
          status = res.status;
          const text = await res.text();
          try { responseData = JSON.parse(text); } catch { responseData = { raw: text }; }
          ok = status >= 200 && status < 300;
        } catch (fetchErr) {
          responseData = { error: String(fetchErr) };
          ok = false;
        }

        const summary = summarize(tc.name, tc.args, responseData, ok);
        const href = ok ? buildHref(tc.name, tc.args, responseData) : undefined;
        const auditId = (responseData as Record<string, unknown>)?.auditId as string | undefined;
        actions.push({ tool: tc.name, args: tc.args, ok, summary, href, auditId });

        toolResults.push({ role: "tool", content: JSON.stringify(responseData), tool_call_id: tc.id });
      }

      if (hitToolCap) {
        // Per-turn tool-call cap reached mid-batch — stop immediately and
        // stream the polite note as the final reply, same resolution path
        // as "the model returned no more tool calls".
        immediateText = TOOL_CAP_NOTE;
        finalMessages = null;
        break;
      }

      providerMessages.push({
        role: "assistant",
        content: result.text ?? null,
        tool_calls: result.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
      providerMessages.push(...toolResults);
    }

    if (finalMessages === null && immediateText === null) {
      // Max steps reached — request a summary without tools
      finalMessages = [
        ...providerMessages,
        { role: "user" as const, content: "Please summarize what you have done so far." },
      ];
    }

    // Build the streaming AsyncIterable for the final text
    const capturedEphemeral = ephemeral;
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await revokeEphemeralToken(capturedEphemeral.id, { actor, conversationId });
    };

    async function* generateChunks(): AsyncIterable<string> {
      try {
        if (immediateText !== null) {
          // Already have the full text from the loop (no tool calls on last turn)
          yield immediateText;
        } else {
          // Stream from provider
          const stream = chatStream({
            provider,
            apiKey,
            model,
            system: SYSTEM_PROMPT,
            messages: finalMessages!,
          });
          for await (const chunk of stream) {
            yield chunk;
          }
        }
      } finally {
        // Revoke ephemeral token after streaming finishes (or on error)
        await release();
      }
    }

    // Transfer ownership — outer finally must NOT revoke (the generator does it)
    ephemeral = null;

    return { actions, usedDemoKey, textChunks: generateChunks(), release };
  } finally {
    // Only runs if we error before returning (ephemeral still set)
    if (ephemeral) {
      await revokeEphemeralToken(ephemeral.id, { actor, conversationId });
    }
  }
}
