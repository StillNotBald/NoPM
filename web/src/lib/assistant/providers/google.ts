/**
 * Google Gemini chat provider.
 * Uses raw fetch — no new npm dependencies.
 */

import type { ToolDefinition, ProviderMessage, ToolCall, ChatResult } from "./openai";

export type { ToolDefinition, ProviderMessage, ToolCall, ChatResult };

/**
 * Stream the final text reply from Google Gemini.
 * Gemini's streamGenerateContent returns a JSON array (line-delimited objects).
 * Each line is a GenerateContentResponse; we yield text parts as they arrive.
 * Only call this when you know there will be NO tool calls.
 */
export async function* chatStream(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
}): AsyncIterable<string> {
  const { apiKey, model, system, messages } = opts;

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
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: "",
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

  const modelPath = model.startsWith("models/") ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google AI API error ${res.status}: ${err}`);
  }

  if (!res.body) throw new Error("Google AI streaming response has no body");

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
        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
          };
          for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
            if (part.text) yield part.text;
          }
        } catch {
          // malformed line — skip
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
