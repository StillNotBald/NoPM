/**
 * NoPM Assistant — agentic loop.
 * Resolves credentials, mints an ephemeral token, runs tool calls
 * through the real NoPM API, and returns { reply, actions, usedDemoKey }.
 */

export const runtime = "nodejs";

import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import type { Actor } from "@/lib/auth/guard";
import { chat, type Provider, type ProviderMessage } from "./providers/index";
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

const DEMO_LIMIT = 20;
const DEMO_WINDOW_SECS = 60 * 60; // 1 hour

/**
 * Durable per-user demo-key rate limit. Backed by a service-role-only table +
 * row-locked SQL function, so the owner-key cap holds across serverless
 * instances and cold starts (an in-memory Map did not). Fail-open on a transient
 * DB error — this is best-effort cost protection, not an auth control.
 */
async function checkDemoRateLimit(
  db: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<void> {
  const { data, error } = await db.rpc("nopm_demo_rate_check", {
    p_user: userId,
    p_limit: DEMO_LIMIT,
    p_window_secs: DEMO_WINDOW_SECS,
  });
  if (error) return; // fail-open
  if (data === false) {
    throw new Error("Demo key rate limit exceeded. Please add your own API key in Settings.");
  }
}

/** Resolve the LLM provider+key+model for this user. */
async function resolveProvider(actor: Actor): Promise<{
  provider: Provider;
  apiKey: string;
  model: string;
  usedDemoKey: boolean;
}> {
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

  await checkDemoRateLimit(db, actor.id);

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
}): Promise<AssistantResult> {
  const { actor, message, history, origin } = opts;

  const { provider, apiKey, model, usedDemoKey } = await resolveProvider(actor);

  const toolDefs = TOOLS.map((t) => t.definition);

  // Build message history for provider
  const providerMessages: ProviderMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: message },
  ];

  const actions: Action[] = [];
  let ephemeral: { raw: string; id: string } | null = null;

  try {
    ephemeral = await mintEphemeralToken(actor);

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

      for (const tc of result.toolCalls) {
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

        const { path, method, body } = spec.toRequest(tc.args);
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
      await revokeEphemeralToken(ephemeral.id);
    }
  }
}
