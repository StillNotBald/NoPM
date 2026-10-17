"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { apiGet } from "@/lib/api-client";

// PUT helper — api-client only exports get/post/patch/delete
async function apiPut<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) {
    throw new Error((json as { error?: string }).error || `Request failed (${res.status})`);
  }
  return json.data as T;
}
import { cn } from "@/lib/cn";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CredentialStatus {
  connected: boolean;
  provider?: string;
  model?: string;
  demoAvailable: boolean;
  // True when the current session is the shared, publicly-reachable
  // one-click demo login (see src/lib/auth/demo.ts) — not a real signed-up
  // user. Always present on the credentials GET response.
  demoSession: boolean;
}

type Provider = "openai" | "anthropic" | "google";

interface ProviderMeta {
  id: Provider;
  label: string;
  models: string[];
  keyPrefix: string;
  keyPlaceholder: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    keyPrefix: "sk-",
    keyPlaceholder: "sk-...",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-3-5"],
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "google",
    label: "Google Gemini",
    models: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
    keyPrefix: "AIza",
    keyPlaceholder: "AIzaSy...",
  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface AssistantSetupProps {
  demoAvailable: boolean;
  onConnected: (status: CredentialStatus) => void;
  onUseDemo: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
//
// Gate flow:
//   - demoAvailable:  "choose" (demo primary / BYOK secondary) → "pick" → "key"
//   - !demoAvailable: "pick" → "key"                            (unchanged legacy path)
//
// The "Try the demo model" tap is always one step, first glance, no key —
// BYOK lives one tap deeper as the deliberately secondary path.

export function AssistantSetup({ demoAvailable, onConnected, onUseDemo }: AssistantSetupProps) {
  const [step, setStep] = useState<"choose" | "pick" | "key">(demoAvailable ? "choose" : "pick");
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].models[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerMeta = PROVIDERS.find((p) => p.id === provider)!;

  function selectProvider(p: Provider) {
    setProvider(p);
    setModel(PROVIDERS.find((x) => x.id === p)!.models[0]);
    setStep("key");
    setError(null);
  }

  async function connect() {
    if (!apiKey.trim()) {
      setError("API key is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPut("/api/assistant/credentials", {
        provider,
        apiKey: apiKey.trim(),
        model,
      });
      const status = await apiGet<CredentialStatus>("/api/assistant/credentials");
      onConnected(status);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save credentials.");
    } finally {
      setSaving(false);
    }
  }

  const heading = step === "choose" ? "Get started" : "Connect your own model";
  const subtext =
    step === "choose"
      ? "Try the assistant instantly with the demo model — or bring your own API key. Every action it takes is scoped and audited."
      : "Bring your own API key. The key is encrypted at rest and never logged. The assistant operates as a scoped token — every action it takes is audited.";

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Heading */}
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-muted">
          AI Assistant
        </p>
        <h2 className="mt-1 text-base font-semibold text-ink">{heading}</h2>
        <p className="mt-1 text-xs text-ink-secondary">{subtext}</p>
      </div>

      {/* ── Step: choose — demo (primary, one tap) vs BYOK (secondary) ────── */}
      {step === "choose" && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={onUseDemo}
            className={cn(
              "flex min-h-[44px] items-center gap-3 rounded-lg border-2 border-accent/30 bg-accent/5 px-4 py-3 text-left transition-colors",
              "hover:border-accent/60 hover:bg-accent/10",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15">
              <Sparkles className="h-4 w-4 text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-accent">Try the demo model</span>
              <span className="block font-mono text-[10px] text-ink-muted">
                One tap · no key needed · grounded in live workspace data
              </span>
            </span>
            <span className="shrink-0 font-mono text-[10px] text-ink-muted">rate-limited</span>
          </button>

          <div className="flex items-center gap-2">
            <span className="h-px flex-1 bg-border-subtle" />
            <span className="font-mono text-[10px] text-ink-muted">or</span>
            <span className="h-px flex-1 bg-border-subtle" />
          </div>

          <button
            type="button"
            onClick={() => setStep("pick")}
            className={cn(
              "flex min-h-[44px] flex-col items-start justify-center gap-0.5 rounded-md border border-dashed border-border-subtle bg-canvas px-3 py-2.5 text-left transition-colors",
              "hover:border-border-strong hover:bg-sunken",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <span className="text-sm font-medium text-ink">Connect your own model</span>
            <span className="font-mono text-[10px] text-ink-muted">
              Use your own OpenAI, Anthropic, or Gemini API key
            </span>
          </button>
        </div>
      )}

      {/* ── Step: pick — provider list (BYOK) ──────────────────────────────── */}
      {step === "pick" && (
        <div className="flex flex-col gap-2">
          {demoAvailable && (
            <button
              onClick={() => setStep("choose")}
              className="mb-1 flex items-center gap-1 font-mono text-xs text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>
          )}
          <p className="font-mono text-xs text-ink-muted">Choose a provider</p>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => selectProvider(p.id)}
              className={cn(
                "flex items-center justify-between rounded-md border border-border-subtle bg-canvas px-3 py-2.5 text-left text-sm transition-colors",
                "hover:border-border-strong hover:bg-sunken",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              <span className="font-medium text-ink">{p.label}</span>
              <span className="font-mono text-xs text-ink-muted">{p.models.length} models</span>
            </button>
          ))}
        </div>
      )}

      {step === "key" && (
        <div className="flex flex-col gap-4">
          {/* Back */}
          <button
            onClick={() => { setStep("pick"); setError(null); setApiKey(""); }}
            className="flex items-center gap-1 font-mono text-xs text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>

          <div className="rounded-md border border-border-subtle bg-sunken px-3 py-2">
            <p className="font-mono text-xs font-semibold text-ink">{providerMeta.label}</p>
          </div>

          {/* API key */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs text-ink-muted" htmlFor="asst-api-key">
              API key
            </label>
            <Input
              id="asst-api-key"
              type="password"
              autoComplete="off"
              placeholder={providerMeta.keyPlaceholder}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") connect(); }}
            />
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-xs text-ink-muted" htmlFor="asst-model">
              Model
            </label>
            <select
              id="asst-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={cn(
                "h-10 w-full rounded-md border border-border-subtle bg-canvas px-3 text-sm text-ink",
                "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent",
              )}
            >
              {providerMeta.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="font-mono text-xs text-danger-ink">{error}</p>
          )}

          <Button
            variant="primary"
            onClick={connect}
            disabled={saving}
            className="w-full"
          >
            {saving ? <Spinner size="sm" className="mr-2" /> : null}
            {saving ? "Connecting…" : "Connect"}
          </Button>
        </div>
      )}
    </div>
  );
}
