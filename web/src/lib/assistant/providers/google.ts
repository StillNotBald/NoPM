/**
 * Google Gemini chat provider.
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

  // Gemini uses "contents" array with "role" (user|model) and "parts"
  type GeminiPart =
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: { content: string } } };

  type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
  };

  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content ?? "" }] });
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "tool") {
      // function response
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: "", // Gemini needs the function name but we only have id; use content as-is
            response: { content: msg.content ?? "" },
          },
        }],
      });
    }
  }

  const body: Record<string, unknown> = {
    contents,
    systemInstruction: {
      role: "user",
      parts: [{ text: system }],
    },
    generationConfig: { maxOutputTokens: 2048 },
  };

  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  // Model name may already include "models/" prefix
  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google AI API error ${res.status}: ${err}`);
  }

  const json = await res.json() as {
    candidates: Array<{
      content: {
        parts: Array<
          | { text: string }
          | { functionCall: { name: string; args: Record<string, unknown> } }
        >;
      };
      finishReason: string;
    }>;
  };

  const candidate = json.candidates?.[0];
  if (!candidate) throw new Error("Google AI returned no candidates");

  let text: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const part of candidate.content?.parts ?? []) {
    if ("text" in part) {
      text = (text ?? "") + part.text;
    } else if ("functionCall" in part) {
      toolCalls.push({
        id: `gemini-${part.functionCall.name}-${Date.now()}`,
        name: part.functionCall.name,
        args: part.functionCall.args,
      });
    }
  }

  return {
    text,
    toolCalls,
    finishReason: candidate.finishReason ?? "STOP",
  };
}
