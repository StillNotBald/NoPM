/**
 * OpenAI chat completion provider.
 * Uses raw fetch — no new npm dependencies.
 */

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProviderMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ChatResult = {
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
};

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

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
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
  if (!choice) throw new Error("OpenAI returned no choices");

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
