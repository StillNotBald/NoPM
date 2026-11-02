/**
 * Provider router — normalizes OpenAI / Anthropic / Google into a single
 * chat(opts) -> ChatResult interface, plus chatStream for the final reply.
 */

export type { ToolDefinition, ProviderMessage, ToolCall, ChatResult } from "./openai";

import * as openai from "./openai";
import * as anthropic from "./anthropic";
import * as google from "./google";
import * as openrouter from "./openrouter";
import type { ToolDefinition, ProviderMessage, ChatResult } from "./openai";

export { ProviderError, providerErrorInfo, providerErrorMessage, type ProviderErrorKind, type ProviderErrorInfo } from "./errors";
import { toProviderError } from "./errors";

export type Provider = "openai" | "anthropic" | "google" | "openrouter";

export async function chat(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
}): Promise<ChatResult> {
  const { provider, ...rest } = opts;
  try {
    switch (provider) {
      case "openai":
        return await openai.chat(rest);
      case "anthropic":
        return await anthropic.chat(rest);
      case "google":
        return await google.chat(rest);
      case "openrouter":
        return await openrouter.chat(rest);
      default:
        throw new Error(`Unknown provider: ${provider as string}`);
    }
  } catch (err) {
    // Typed failure for the caller to log and show; timeouts and network
    // errors are normalised, the upstream body is never kept.
    throw toProviderError(provider, err);
  }
}

/**
 * Stream the final reply text as an AsyncIterable<string>.
 * Only use this after the agentic loop has completed (no more tool calls).
 * Passes no tools — every provider will emit only text.
 */
export async function* chatStream(opts: {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
}): AsyncIterable<string> {
  const { provider, ...rest } = opts;
  try {
    switch (provider) {
      case "openai":
        yield* openai.chatStream(rest);
        break;
      case "anthropic":
        yield* anthropic.chatStream(rest);
        break;
      case "google":
        yield* google.chatStream(rest);
        break;
      case "openrouter":
        yield* openrouter.chatStream(rest);
        break;
      default:
        throw new Error(`Unknown provider: ${provider as string}`);
    }
  } catch (err) {
    throw toProviderError(provider, err);
  }
}
