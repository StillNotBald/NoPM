/**
 * Typed provider errors (audit A2).
 *
 * Every model provider failure is turned into a ProviderError with a small,
 * fixed `kind`, so the chat route can log it, tell the client what happened
 * and let the panel show a banner. The upstream response body is NEVER kept:
 * it can echo request text or key fragments. Only the kind, provider name and
 * HTTP status survive.
 */

export type ProviderErrorKind = "key_invalid" | "rate_limited" | "model_not_found" | "unavailable" | "timeout";

export const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  "key_invalid",
  "rate_limited",
  "model_not_found",
  "unavailable",
  "timeout",
];

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Upstream HTTP status, 0 when there was none (timeout, network failure). */
  readonly status: number;
  readonly provider: string;
  constructor(kind: ProviderErrorKind, status: number, provider: string, message?: string) {
    super(message ?? `${provider} request failed (${kind}, HTTP ${status})`);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.provider = provider;
  }
}

/** Map an upstream HTTP status to an error kind. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "key_invalid";
  if (status === 404) return "model_not_found";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  return "unavailable";
}

/** The error to throw for a non-OK provider response. Never includes the body. */
export function providerHttpError(provider: string, status: number): ProviderError {
  return new ProviderError(kindForStatus(status), status, provider);
}

/**
 * Normalise anything a provider call can throw into a ProviderError: a timeout
 * (AbortSignal.timeout) becomes `timeout`, any other non-typed failure (network
 * error, bad JSON) becomes `unavailable`. A ProviderError passes through.
 */
export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new ProviderError("timeout", 0, provider);
  return new ProviderError("unavailable", 0, provider);
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * The clear message sent to the client. No upstream text, no key. A demo
 * visitor runs on the maintainer's key, so they get no "fix your key or model"
 * advice they cannot act on.
 */
export function providerErrorMessage(kind: ProviderErrorKind, provider: string, opts: { demo?: boolean } = {}): string {
  if (opts.demo) {
    switch (kind) {
      case "rate_limited":
        return "The demo model is busy right now. Try again in a minute.";
      case "timeout":
        return "The demo model took too long to answer. Try again.";
      default:
        return "The demo model is unavailable right now. Try again later.";
    }
  }
  const who = providerLabel(provider);
  switch (kind) {
    case "key_invalid":
      return `Your ${who} key was rejected. Update it in the assistant settings.`;
    case "rate_limited":
      return `${who} is rate limiting requests or your account is out of credit. Try again in a minute.`;
    case "model_not_found":
      return `${who} does not know the selected model. Choose another model in the assistant settings.`;
    case "timeout":
      return `${who} took too long to answer. Try again.`;
    default:
      return `${who} is unavailable right now. Try again shortly.`;
  }
}

/**
 * What goes to the client alongside the reply (additive field `provider_error`).
 * On the demo key `demo` is true and `provider` is "demo" (the maintainer's
 * provider is not shown), so the panel can drop its own key advice.
 */
export type ProviderErrorInfo = { kind: ProviderErrorKind; provider: string; status: number; message: string; demo?: true };

export function providerErrorInfo(e: ProviderError, opts: { demo?: boolean } = {}): ProviderErrorInfo {
  const message = providerErrorMessage(e.kind, e.provider, opts);
  if (opts.demo) return { kind: e.kind, provider: "demo", status: e.status, message, demo: true };
  return { kind: e.kind, provider: e.provider, status: e.status, message };
}
