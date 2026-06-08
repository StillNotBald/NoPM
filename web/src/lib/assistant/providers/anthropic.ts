/**
 * Anthropic (Claude) chat provider.
 * Uses raw fetch — no new npm dependencies.
 */

import type { ToolDefinition, ProviderMessage, ToolCall, ChatResult } from "./openai";

export type { ToolDefinition, ProviderMessage, ToolCall, ChatResult };

export async function chat(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
}): Promise<ChatResult> {
  const { apiKey, model, system, messages, tools } = opts;

  // Convert messages to Anthropic format
  // Anthropic doesn't have a "tool" role — tool results go as user content blocks
  type AnthropicMessage = {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  };
  type AnthropicContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string };

  const anthropicMessages: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      // tool result — append to previous user message or start new one
      const last = anthropicMessages[anthropicMessages.length - 1];
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: msg.content ?? "",
      };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        anthropicMessages.push({ role: "user", content: [block] });
      }
    } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: (() => {
            try { return JSON.parse(tc.function.arguments) as Record<string, unknown>; }
            catch { return {}; }
          })(),
        });
      }
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else {
      anthropicMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content ?? "",
      });
    }
  }

  const body: Record<string, unknown> = {
    model,
    system,
    messages: anthropicMessages,
    max_tokens: 2048,
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const json = await res.json() as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
    stop_reason: string;
  };

  let text: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const block of json.content) {
    if (block.type === "text") {
      text = (text ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
  }

  return {
    text,
    toolCalls,
    finishReason: json.stop_reason ?? "end_turn",
  };
}
