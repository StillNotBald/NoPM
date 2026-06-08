"use client";

import { useState } from "react";
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

export function AssistantSetup({ demoAvailable, onConnected, onUseDemo }: AssistantSetupProps) {
  const [step, setStep] = useState<"pick" | "key">("pick");
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

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* Heading */}
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink-muted">
          AI Assistant
        </p>
        <h2 className="mt-1 text-base font-semibold text-ink">Connect your model</h2>
        <p className="mt-1 text-xs text-ink-secondary">
          Bring your own API key. The key is encrypted at rest and never logged.
          The assistant operates as a scoped token — every action it takes is audited.
        </p>
      </div>

      {step === "pick" && (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs text-ink-muted">Choose a provider</p>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => selectProvider(p.id)}
              className={cn(
                "flex items-center justify-between rounded-md border border-border-subtle bg-canvas px-3 py-2.5 text-left text-sm transition-colors",
                "hover:border-border-strong hover:bg-sunken",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              )}
            >
              <span className="font-medium text-ink">{p.label}</span>
              <span className="font-mono text-xs text-ink-muted">{p.models.length} models</span>
            </button>
          ))}

          {demoAvailable && (
            <>
              <div className="my-1 flex items-center gap-2">
                <span className="h-px flex-1 bg-border-subtle" />
                <span className="font-mono text-[10px] text-ink-muted">or</span>
                <span className="h-px flex-1 bg-border-subtle" />
              </div>
              <button
                onClick={onUseDemo}
                className={cn(
                  "flex items-center gap-2 rounded-md border border-dashed border-border-subtle bg-canvas px-3 py-2.5 text-left text-sm transition-colors",
                  "hover:border-accent/40 hover:bg-sunken",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                )}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                <span className="font-medium text-accent">Try the demo model</span>
                <span className="ml-auto font-mono text-[10px] text-ink-muted">rate-limited</span>
              </button>
            </>
          )}
        </div>
      )}

      {step === "key" && (
        <div className="flex flex-col gap-4">
          {/* Back */}
          <button
            onClick={() => { setStep("pick"); setError(null); setApiKey(""); }}
            className="flex items-center gap-1 font-mono text-xs text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
              )}
            >
              {providerMeta.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="font-mono text-xs text-danger">{error}</p>
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
