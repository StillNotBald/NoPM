/**
 * Provider router — normalizes OpenAI / Anthropic / Google into a single
 * chat(opts) -> ChatResult interface, plus chatStream for the final reply.
 */

export type { ToolDefinition, ProviderMessage, ToolCall, ChatResult } from "./openai";

import * as openai from "./openai";
import * as anthropic from "./anthropic";
import * as google from "./google";
import type { ToolDefinition, ProviderMessage, ChatResult } from "./openai";

export type Provider = "openai" | "anthropic" | "google";

export async function chat(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
}): Promise<ChatResult> {
  const { provider, ...rest } = opts;
  switch (provider) {
    case "openai":
      return openai.chat(rest);
    case "anthropic":
      return anthropic.chat(rest);
    case "google":
      return google.chat(rest);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}

/**
 * Stream the final reply text as an AsyncIterable<string>.
 * Only use this after the agentic loop has completed (no more tool calls).
 * Passes no tools — every provider will emit only text.
 */
export function chatStream(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
}): AsyncIterable<string> {
  const { provider, ...rest } = opts;
  switch (provider) {
    case "openai":
      return openai.chatStream(rest);
    case "anthropic":
      return anthropic.chatStream(rest);
    case "google":
      return google.chatStream(rest);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
