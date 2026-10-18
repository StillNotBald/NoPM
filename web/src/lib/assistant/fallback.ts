/**
 * Deterministic, grounded fallback for the NoPM assistant.
 *
 * Used when the real LLM provider call fails (no credentials, demo key
 * exhausted, upstream capacity/rate-limit, transient network error, etc.).
 * NEVER calls a provider — it answers by running a small, fixed set of
 * READ-ONLY tools from the SAME tool registry (`./tools`) through the SAME
 * ephemeral-scoped-token lifecycle used by the real agentic loop, and
 * composes a plain-text reply strictly from the real data those tools
 * return. It never invents numbers and never selects a write tool.
 *
 * Governance:
 *  - Mints and revokes its own ephemeral token (mirrors index.ts's
 *    runAssistant — resolveProvider there can throw BEFORE any token
 *    exists, so this path needs an independent mint/revoke lifecycle).
 *  - Takes an injected `rateCheck` callback and calls it FIRST, before
 *    minting a token or touching any tool, so the fallback can never be
 *    used to bypass the caller's demo rate limit.
 *  - Only ever calls tools whose registry-derived HTTP method is GET
 *    (`FALLBACK_READ_ONLY_TOOLS`) — never a write tool.
 */

import type { Actor } from "@/lib/auth/guard";
import type { Action } from "./index";
import { TOOLS } from "./tools";
import { mintEphemeralToken, revokeEphemeralToken } from "./token";

export const runtime = "nodejs";

export type FallbackResult = {
  reply: string;
  actions: Action[];
  usedFallback: true;
  usedDemoKey: false;
};

/**
 * The subset of TOOLS this module is allowed to call — derived from the
 * registry itself (every ToolSpec whose `toRequest` builds a GET request),
 * not a hand-maintained allowlist that could silently drift from tools.ts.
 * `create_*` and `request_task_deletion` (DELETE) are excluded by
 * construction.
 */
export const FALLBACK_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  TOOLS.filter((t) => t.toRequest({}).method === "GET").map((t) => t.definition.name),
);

type ToolCallResult = { ok: boolean; data: unknown };

/** Execute one read-only tool call via the ephemeral token, recording an Action. */
async function callReadTool(
  name: string,
  args: Record<string, unknown>,
  ephemeralRaw: string,
  origin: string,
  actions: Action[],
  requestId?: string,
): Promise<ToolCallResult> {
  const spec = TOOLS.find((t) => t.definition.name === name);
  if (!spec || !FALLBACK_READ_ONLY_TOOLS.has(name)) {
    // Defensive — every call site below only ever passes a name that is
    // already in FALLBACK_READ_ONLY_TOOLS. This guards against a future
    // edit accidentally wiring in a write tool.
    throw new Error(`fallback: refusing to call non-read-only tool "${name}"`);
  }

  // A refused argument (ToolArgError: a non-UUID id, a path-splicing value) is a
  // failed tool call, never an exception that aborts the whole fallback reply.
  let built: { path: string; method: string };
  try {
    built = spec.toRequest(args);
  } catch (argErr) {
    const message = `Bad arguments: ${argErr instanceof Error ? argErr.message : String(argErr)}`;
    actions.push({ tool: name, args, ok: false, summary: `${name} failed (fallback): ${message}` });
    return { ok: false, data: { error: message } };
  }
  const { path, method } = built;
  let data: unknown = null;
  let ok = false;

  try {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ephemeralRaw}`,
        "X-NoPM-Client": "assistant",
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
    });
    ok = res.status >= 200 && res.status < 300;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  } catch (fetchErr) {
    data = { error: String(fetchErr) };
    ok = false;
  }

  actions.push({
    tool: name,
    args,
    ok,
    summary: ok ? `${name} completed (fallback)` : `${name} failed (fallback)`,
  });

  return { ok, data };
}

const CAPABILITY_HINT =
  'You can ask me things like: "what\'s the project status?", "what are the top open risks?", or "show recent activity".';

type ListEnvelope = { total?: number; data?: Array<Record<string, unknown>> };

function asListEnvelope(data: unknown): ListEnvelope {
  return (data ?? {}) as ListEnvelope;
}

async function buildPortfolioReply(ephemeralRaw: string, origin: string, actions: Action[], requestId?: string): Promise<string> {
  const { ok, data } = await callReadTool("list_projects", { page: 1, limit: 50 }, ephemeralRaw, origin, actions, requestId);
  if (!ok) {
    return `I'm running in limited fallback mode right now and couldn't reach the projects list. Please try again shortly.\n\n${CAPABILITY_HINT}`;
  }
  const { total, data: rows } = asListEnvelope(data);
  const projects = rows ?? [];
  if (!total) {
    return "This workspace has no projects yet.";
  }

  const counts = new Map<string, number>();
  for (const p of projects) {
    const status = String(p.rag_status ?? "unknown");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");

  return `The workspace has ${total} project${total === 1 ? "" : "s"} in total. Status breakdown across the ${projects.length} most recently updated: ${breakdown}.`;
}

async function buildRisksReply(ephemeralRaw: string, origin: string, actions: Action[], requestId?: string): Promise<string> {
  const projResult = await callReadTool("list_projects", { page: 1, limit: 5 }, ephemeralRaw, origin, actions, requestId);
  if (!projResult.ok) {
    return `I'm running in limited fallback mode right now and couldn't reach the projects list to look up risks. Please try again shortly.\n\n${CAPABILITY_HINT}`;
  }
  const projects = (asListEnvelope(projResult.data).data ?? []) as Array<{ id?: string; name?: string }>;
  if (projects.length === 0) {
    return "This workspace has no projects, so there are no risks to report.";
  }

  const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  type OpenRisk = { title: string; severity: string; projectName: string };
  const openRisks: OpenRisk[] = [];

  for (const p of projects) {
    if (!p.id) continue;
    const riskResult = await callReadTool(
      "list_risks",
      { project_id: p.id, page: 1, limit: 50 },
      ephemeralRaw,
      origin,
      actions,
      requestId,
    );
    if (!riskResult.ok) continue;
    const risks = asListEnvelope(riskResult.data).data ?? [];
    for (const r of risks) {
      if (r.status === "open") {
        openRisks.push({
          title: String(r.title ?? "Untitled risk"),
          severity: String(r.severity ?? "unknown"),
          projectName: String(p.name ?? p.id),
        });
      }
    }
  }

  if (openRisks.length === 0) {
    return `No open risks found across the ${projects.length} most recent project${projects.length === 1 ? "" : "s"}.`;
  }

  openRisks.sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0));
  const top = openRisks.slice(0, 5);
  const lines = top.map((r) => `- ${r.title} (${r.severity} severity, ${r.projectName})`).join("\n");

  return `Top open risks across ${projects.length} recent project${projects.length === 1 ? "" : "s"}:\n${lines}`;
}

async function buildAuditReply(ephemeralRaw: string, origin: string, actions: Action[], requestId?: string): Promise<string> {
  const { ok, data } = await callReadTool("query_audit", { page: 1, limit: 5 }, ephemeralRaw, origin, actions, requestId);
  if (!ok) {
    return `I'm running in limited fallback mode right now and couldn't reach the audit trail. Please try again shortly.\n\n${CAPABILITY_HINT}`;
  }
  const { total, data: rows } = asListEnvelope(data);
  const entries = rows ?? [];
  if (entries.length === 0) {
    return "No audit activity recorded yet in this workspace.";
  }
  const lines = entries
    .map((e) => `- ${String(e.action ?? "unknown action")} on ${String(e.target_type ?? "unknown")}`)
    .join("\n");

  return `Recent activity (${total ?? entries.length} audit entries total). Most recent:\n${lines}`;
}

async function buildDefaultReply(ephemeralRaw: string, origin: string, actions: Action[], requestId?: string): Promise<string> {
  const { ok, data } = await callReadTool("list_projects", { page: 1, limit: 5 }, ephemeralRaw, origin, actions, requestId);
  const prefix = "The AI assistant is running in limited fallback mode right now.";
  if (!ok) {
    return `${prefix} I couldn't reach the workspace data just now.\n\n${CAPABILITY_HINT}`;
  }
  const { total } = asListEnvelope(data);
  return `${prefix} This workspace currently has ${total ?? 0} project${total === 1 ? "" : "s"}.\n\n${CAPABILITY_HINT}`;
}

/** Deterministic keyword intent match — most-specific intents checked first. */
function matchIntent(message: string): "risks" | "audit" | "portfolio" | "default" {
  const m = message.toLowerCase();
  if (/\brisks?\b/.test(m)) return "risks";
  if (/\b(audit|trust center|recent (change|activity)|activity log|history)\b/.test(m)) return "audit";
  if (/\b(project|projects|portfolio|status|overview|summary)\b/.test(m)) return "portfolio";
  return "default";
}

/**
 * The lines that keep an earlier, already-executed turn visible after the
 * provider failed: every action the turn ran, with its own summary (a failed
 * one says it failed). Plain text built from the action log, nothing invented.
 */
export function priorActionsNote(prior: Action[]): string {
  const lines = prior.map((a) => `- ${a.summary}`).join("\n");
  return `The AI provider stopped responding partway through. These actions had already been carried out:\n${lines}`;
}

export async function runAssistantFallback(opts: {
  actor: Actor;
  message: string;
  origin: string;
  /** The caller's real rate-limit check. Called FIRST, before any token is
   *  minted or any tool is executed — the fallback can never bypass it. */
  rateCheck: () => Promise<void>;
  /** Incoming X-Request-Id from the chat request, forwarded into the
   *  fallback's own tool-call fetches (R-82). */
  requestId?: string;
  /** The conversation this turn belongs to (token mint/revoke audit rows, A3-14). */
  conversationId?: string | null;
  /**
   * Actions the real provider's turn had already executed before it failed
   * (D-ACC-8). They are NOT undone by the failure, so the reply must still say
   * what was done and the result keeps them ahead of the fallback's own reads.
   */
  priorActions?: Action[];
}): Promise<FallbackResult> {
  const { actor, message, origin, rateCheck, requestId, conversationId = null } = opts;
  const prior = opts.priorActions ?? [];

  await rateCheck();

  const actions: Action[] = [];
  let ephemeral: { raw: string; id: string } | null = null;

  try {
    ephemeral = await mintEphemeralToken(actor, { conversationId });

    const intent = matchIntent(message);
    let reply: string;

    switch (intent) {
      case "risks":
        reply = await buildRisksReply(ephemeral.raw, origin, actions, requestId);
        break;
      case "audit":
        reply = await buildAuditReply(ephemeral.raw, origin, actions, requestId);
        break;
      case "portfolio":
        reply = await buildPortfolioReply(ephemeral.raw, origin, actions, requestId);
        break;
      default:
        reply = await buildDefaultReply(ephemeral.raw, origin, actions, requestId);
        break;
    }

    if (prior.length > 0) {
      reply = `${priorActionsNote(prior)}\n\n${reply}`;
    }

    return { reply, actions: [...prior, ...actions], usedFallback: true, usedDemoKey: false };
  } finally {
    if (ephemeral) {
      await revokeEphemeralToken(ephemeral.id, { actor, conversationId });
    }
  }
}
