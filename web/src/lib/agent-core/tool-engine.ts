/**
 * Shared tool-execution engine (audit A13).
 *
 * One implementation of "run the model's tool calls through the real NoPM API",
 * used by the in-app assistant (JSON and streaming paths) and ready for any
 * other channel (a chat bot, a scheduled job) that holds a server-side actor
 * and a scoped token. The caller supplies the token, the origin and the channel
 * label; this module never mints or revokes tokens and never talks to a client.
 *
 * Behaviour is exactly what `runAssistant` / `runAssistantStream` used to do
 * inline: the same step cap, tool cap, argument guarding and action records.
 */

import { chat, type ProviderMessage, type ToolCall, type ToolDefinition, type Provider } from "@/lib/assistant/providers/index";
import { TOOLS, type ToolSpec } from "@/lib/assistant/tools";
import { wrapUntrustedToolResult } from "./untrusted";

/** A single governed action the assistant took. */
export type Action = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  href?: string;
  /** Id of the record the call created or changed (data.id), when the API returned one. */
  entityId?: string;
  auditId?: string;
};

/** Hard cap on how many tool calls may EXECUTE within one turn. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

/** A tool result sent to the model is cut at this many characters (A10). */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * Bound a tool result before it goes back to the model (A10). A list loses
 * trailing rows (and says so, keeping `total`); anything else is replaced by a
 * truncation notice plus the start of the text. Always valid JSON.
 */
export function boundToolResult(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const full = JSON.stringify(value) ?? "null";
  if (full.length <= max) return full;
  const hint = "Result was too long and was cut. Use fields= or view=summary, a smaller limit, or the page argument.";
  const rec = value as Record<string, unknown> | null;
  if (rec && typeof rec === "object" && Array.isArray(rec.data)) {
    const rows = rec.data as unknown[];
    let keep = rows.length;
    while (keep > 0) {
      keep = Math.floor(keep / 2);
      const attempt = JSON.stringify({ ...rec, data: rows.slice(0, keep), truncated: true, returned: keep, hint });
      if (attempt.length <= max) return attempt;
    }
  }
  const room = Math.max(0, max - hint.length - 120);
  return JSON.stringify({ truncated: true, original_chars: full.length, hint, partial: full.slice(0, room) });
}

/** Provider round-trips per turn before the model is asked for a final summary. */
export const MAX_STEPS = 6;

export const TOOL_CAP_NOTE =
  "I've reached the limit of tool actions I can take in a single turn " +
  `(${MAX_TOOL_CALLS_PER_TURN}). Here's what I completed — ask me to continue if you'd like more.`;

/** Where and as whom a tool call is made. */
export type ToolExecContext = {
  /** Origin of the NoPM API (e.g. https://host). */
  origin: string;
  /** The raw scoped bearer token for this turn. */
  token: string;
  /** Incoming request id, forwarded so audit rows correlate back to the request (R-82). */
  requestId?: string;
  /** Channel label sent as X-NoPM-Client. Informational only; audit channel is server-derived. */
  channel?: string;
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
  spec: ToolSpec,
  args: Record<string, unknown>,
): { ok: true; path: string; method: string; body?: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, ...spec.toRequest(args) };
  } catch (err) {
    return { ok: false, message: `Bad arguments: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Build a human-readable summary from a tool name + result. */
export function summarize(toolName: string, args: Record<string, unknown>, result: unknown, ok: boolean): string {
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
    default: return genericSummary(toolName, args, r, data);
  }
}

function noun(raw: string): string {
  return raw.replace(/_/g, " ");
}

/** Fields worth naming in an update chip: the ones the caller changed, not ids or concurrency guards. */
function changedFields(args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((k) => !/(^|_)id$/.test(k) && k !== "expected_updated_at" && args[k] !== undefined);
}

function recordLabel(data: Record<string, unknown> | null): string {
  const v = data?.name ?? data?.title ?? data?.code;
  return typeof v === "string" && v ? ` "${v.slice(0, 80)}"` : "";
}

/**
 * Chip text for any tool without a hand-written line (A11), built from the
 * tool's name: create_x, update_x, request_x_deletion, list_x, get_x. It says
 * what happened instead of a bare "completed".
 */
export function genericSummary(
  toolName: string,
  args: Record<string, unknown>,
  r: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
): string {
  let m: RegExpExecArray | null;
  if ((m = /^create_(.+)$/.exec(toolName))) return `Created ${noun(m[1])}${recordLabel(data)}`;
  if ((m = /^update_(.+)$/.exec(toolName))) {
    const fields = changedFields(args);
    return `Updated ${noun(m[1])}${recordLabel(data)}${fields.length ? ` (${fields.slice(0, 5).join(", ")})` : ""}`;
  }
  if ((m = /^request_(.+)_deletion$/.exec(toolName))) return `Requested deletion of ${noun(m[1])} (pending approval)`;
  if (toolName === "withdraw_deletion_request") return "Withdrew a deletion request";
  if ((m = /^list_(.+)$/.exec(toolName))) return `Listed ${(r?.total as number | undefined) ?? "?"} ${noun(m[1])}`;
  if ((m = /^get_(.+)$/.exec(toolName))) return `Retrieved ${noun(m[1])}`;
  const words = noun(toolName);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} done`;
}

/** Build a deep-link href for a newly created entity, if possible. */
export function buildHref(toolName: string, args: Record<string, unknown>, result: unknown): string | undefined {
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
    case "update_project":
      return `/projects/${(data.id as string | undefined) ?? (args.project_id as string | undefined) ?? ""}`;
    case "update_milestone":
      return projectId ? `/projects/${projectId}/milestones` : undefined;
    case "update_task":
      return projectId ? `/projects/${projectId}/tasks` : undefined;
    case "update_risk":
      return projectId ? `/projects/${projectId}/risks` : undefined;
    case "update_issue":
      return projectId ? `/projects/${projectId}/issues` : undefined;
    default:
      return undefined;
  }
}


/**
 * Execute ONE tool call. Never throws: an unknown tool, refused arguments or a
 * network failure all come back as a failed action + a failed tool message the
 * model can correct.
 */
export async function executeToolCall(
  tc: ToolCall,
  ctx: ToolExecContext,
): Promise<{ action: Action; message: ProviderMessage }> {
  const spec = TOOLS.find((t) => t.definition.name === tc.name);
  if (!spec) {
    return {
      action: { tool: tc.name, args: tc.args, ok: false, summary: `Unknown tool: ${tc.name}` },
      message: { role: "tool", content: wrapUntrustedToolResult(tc.name, JSON.stringify({ error: `Unknown tool: ${tc.name}` })), tool_call_id: tc.id },
    };
  }

  const built = buildToolCall(spec, tc.args);
  if (!built.ok) {
    return {
      action: { tool: tc.name, args: tc.args, ok: false, summary: built.message },
      message: { role: "tool", content: wrapUntrustedToolResult(tc.name, JSON.stringify({ error: built.message })), tool_call_id: tc.id },
    };
  }
  const { path, method, body } = built;

  let responseData: unknown = null;
  let ok = false;

  try {
    const fetchOpts: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.token}`,
        "X-NoPM-Client": ctx.channel ?? "assistant",
        ...(ctx.requestId ? { "X-Request-Id": ctx.requestId } : {}),
      },
    };
    if (body !== undefined && method !== "GET") {
      fetchOpts.body = JSON.stringify(body);
    }
    const res = await fetch(`${ctx.origin}${path}`, fetchOpts);
    const text = await res.text();
    try { responseData = JSON.parse(text); } catch { responseData = { raw: text }; }
    ok = res.status >= 200 && res.status < 300;
  } catch (fetchErr) {
    // Fixed text on purpose: the raw error can carry the internal origin.
    void fetchErr;
    responseData = { error: "network error calling NoPM" };
    ok = false;
  }

  const summary = summarize(tc.name, tc.args, responseData, ok);
  const href = ok ? buildHref(tc.name, tc.args, responseData) : undefined;
  const auditId = (responseData as Record<string, unknown>)?.auditId as string | undefined;

  const rawId = ((responseData as Record<string, unknown> | null)?.data as Record<string, unknown> | null | undefined)?.id;
  const entityId = ok && typeof rawId === "string" ? rawId : undefined;

  return {
    action: { tool: tc.name, args: tc.args, ok, summary, href, entityId, auditId },
    message: { role: "tool", content: wrapUntrustedToolResult(tc.name, boundToolResult(responseData)), tool_call_id: tc.id },
  };
}

/** A tool call naming a tool that was not offered this turn: refused, never sent. */
function notOffered(tc: ToolCall): { action: Action; message: ProviderMessage } {
  const error = `Tool not available here: ${tc.name}`;
  return {
    action: { tool: tc.name, args: tc.args, ok: false, summary: error },
    message: { role: "tool", content: wrapUntrustedToolResult(tc.name, JSON.stringify({ error })), tool_call_id: tc.id },
  };
}

/** How the tool rounds ended. */
export type ToolRoundsOutcome =
  /** The model answered in plain text (`text` may be null when it returned nothing). */
  | { kind: "text"; text: string | null }
  /** The per-turn tool-call cap was hit mid-batch. */
  | { kind: "cap" }
  /** MAX_STEPS provider calls were spent with tools still being requested. */
  | { kind: "max_steps" };

/**
 * The agentic loop: ask the model, run its tool calls, feed results back.
 * `messages` is mutated (assistant tool_calls turns and tool results are
 * appended) so the caller can continue from it. Every action is pushed onto
 * `actions` as it runs, so a caller still has them if a later step throws.
 */
export async function runToolRounds(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  ctx: ToolExecContext;
  actions: Action[];
}): Promise<ToolRoundsOutcome> {
  const { provider, apiKey, model, system, messages, tools, ctx, actions } = opts;
  const offered = new Set(tools.map((t) => t.name));
  let toolCallsExecuted = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await chat({ provider, apiKey, model, system, messages, tools });

    if (result.toolCalls.length === 0) {
      return { kind: "text", text: result.text };
    }

    const toolResults: ProviderMessage[] = [];
    let hitToolCap = false;

    for (const tc of result.toolCalls) {
      if (toolCallsExecuted >= MAX_TOOL_CALLS_PER_TURN) {
        hitToolCap = true;
        break;
      }
      toolCallsExecuted++;
      // Only the tools offered this turn may run, even if the model names
      // another one (a channel that offers read tools only must not depend
      // on the token's scopes alone to refuse a write).
      const { action, message } = offered.has(tc.name)
        ? await executeToolCall(tc, ctx)
        : notOffered(tc);
      actions.push(action);
      toolResults.push(message);
    }

    if (hitToolCap) {
      // Stop immediately rather than continue with an inconsistent
      // tool_calls / tool_results pairing.
      return { kind: "cap" };
    }

    messages.push({
      role: "assistant",
      content: result.text ?? null,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });
    messages.push(...toolResults);
  }

  return { kind: "max_steps" };
}
