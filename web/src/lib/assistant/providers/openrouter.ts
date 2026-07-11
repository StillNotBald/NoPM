/**
 * OpenRouter chat completion provider.
 * OpenRouter exposes an OpenAI-schema-compatible /chat/completions endpoint
 * across many upstream models, so request/response shapes mirror openai.ts.
 * Uses raw fetch — no new npm dependencies.
 */

import type { ToolDefinition, ProviderMessage, ToolCall, ChatResult } from "./openai";

export type { ToolDefinition, ProviderMessage, ToolCall, ChatResult };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Thrown when OpenRouter signals rate-limit or capacity exhaustion
 * (HTTP 429 Too Many Requests / 503 Service Unavailable — common on
 * OpenRouter's free-tier models). Callers can distinguish this from other
 * failures via `instanceof OpenRouterCapacityError` or `error.name ===
 * "OpenRouterCapacityError"`.
 *
 * The message NEVER contains the raw upstream response body — only the
 * HTTP status — because free-tier error bodies can echo back fragments of
 * request headers/keys.
 */
export class OpenRouterCapacityError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`OpenRouter capacity/rate limit exceeded (HTTP ${status})`);
    this.name = "OpenRouterCapacityError";
    this.status = status;
  }
}

/**
 * Translate a non-OK OpenRouter response into a thrown Error, never
 * including the upstream response body — status code only.
 */
function throwForStatus(status: number): never {
  if (status === 429 || status === 503) {
    throw new OpenRouterCapacityError(status);
  }
  throw new Error(`OpenRouter API error ${status}`);
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    // Required by OpenRouter to attribute traffic; also unlocks some free-tier models.
    "HTTP-Referer": "https://stillnotbald.com",
    "X-Title": "NoPM",
  };
}

/**
 * Stream the final text reply from OpenRouter via SSE (OpenAI-compatible framing).
 * Yields text chunks as they arrive.
 * Only call this when you know there will be NO tool calls (tools: []).
 */
export async function* chatStream(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
}): AsyncIterable<string> {
  const { apiKey, model, system, messages } = opts;

  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: [
      { role: "system", content: system },
      ...messages,
    ],
    max_tokens: 2048,
  };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    throwForStatus(res.status);
  }

  if (!res.body) throw new Error("OpenRouter streaming response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string | null } }>;
          };
          const chunk = parsed.choices?.[0]?.delta?.content;
          if (chunk) yield chunk;
        } catch {
          // malformed SSE line — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function chat(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
}): Promise<ChatResult> {
  const { apiKey, model, system, messages, tools } = opts;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      ...messages,
    ],
    max_tokens: 2048,
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    throwForStatus(res.status);
  }

  const json = await res.json() as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      finish_reason: string;
    }>;
  };

  const choice = json.choices[0];
  if (!choice) throw new Error("OpenRouter returned no choices");

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: (() => {
      try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
      catch { return {}; }
    })(),
  }));

  return {
    text: choice.message.content,
    toolCalls,
    finishReason: choice.finish_reason ?? "stop",
  };
}
