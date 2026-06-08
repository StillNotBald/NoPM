"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, ArrowUp, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { apiGet, apiDelete, apiPost } from "@/lib/api-client";
import { AssistantSetup, type CredentialStatus } from "./setup";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Action {
  tool: string;
  args: object;
  ok: boolean;
  summary: string;
  href?: string;
  auditId?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  actions?: Action[];
  usedDemoKey?: boolean;
}

interface ChatResponse {
  reply: string;
  actions: Action[];
  usedDemoKey: boolean;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

// ── Action chip ───────────────────────────────────────────────────────────────

function ActionChip({ action }: { action: Action }) {
  const tone = action.ok ? "success" : "danger";
  const chip = (
    <Badge
      tone={tone}
      className={cn(
        "max-w-full gap-1 truncate",
        action.href && "cursor-pointer hover:opacity-80 transition-opacity",
      )}
      title={action.summary}
    >
      {action.ok ? (
        <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
      <span className="truncate">{action.summary}</span>
      {action.href && <ExternalLink className="h-2.5 w-2.5 shrink-0" />}
    </Badge>
  );

  if (action.href) {
    return (
      <a href={action.href} target="_blank" rel="noopener noreferrer" className="block max-w-full">
        {chip}
      </a>
    );
  }
  return chip;
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  return (
    <div className={cn("flex flex-col gap-1", isUser && "items-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-accent text-accent-ink rounded-br-sm"
            : "bg-sunken text-ink rounded-bl-sm",
        )}
      >
        <p className="whitespace-pre-wrap break-words">{msg.content}</p>
      </div>

      {/* Action chips */}
      {msg.actions && msg.actions.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap gap-1">
          {msg.actions.map((a, i) => (
            <ActionChip key={i} action={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Empty / welcome state ─────────────────────────────────────────────────────

function WelcomeState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10">
        <Sparkles className="h-5 w-5 text-accent" />
      </div>
      <div>
        <p className="font-mono text-sm font-semibold text-ink-secondary">AI Assistant ready</p>
        <p className="mt-0.5 font-mono text-xs text-ink-muted">
          Ask me to create tasks, update milestones, check risks, or query your project data.
        </p>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function AssistantPanel({ open, onClose, triggerRef }: AssistantPanelProps) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [disconnecting, setDisconnecting] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // ── Fetch credential status on open ───────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const s = await apiGet<CredentialStatus>("/api/assistant/credentials");
      setStatus(s);
    } catch {
      // silently ignore; treat as not connected
      setStatus({ connected: false, demoAvailable: false });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchStatus();
    }
  }, [open, fetchStatus]);

  // ── Focus management ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      closeBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        requestAnimationFrame(() => triggerRef?.current?.focus());
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, triggerRef]);

  // ── Auto-scroll to bottom ────────────────────────────────────────────────

  useEffect(() => {
    if (history.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [history]);

  // ── Send message ──────────────────────────────────────────────────────────

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = { role: "user", content: text };
    setHistory((h) => [...h, userMsg]);
    setInput("");
    setSending(true);
    setSendError(null);

    try {
      const apiHistory = history.map((m) => ({ role: m.role, content: m.content }));
      const res = await apiPost<ChatResponse>("/api/assistant/chat", {
        message: text,
        history: apiHistory,
      });

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: res.reply,
        actions: res.actions,
        usedDemoKey: res.usedDemoKey,
      };
      setHistory((h) => [...h, assistantMsg]);
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : "Failed to send message.");
      // Remove the optimistic user message on failure
      setHistory((h) => h.slice(0, -1));
      setInput(text);
    } finally {
      setSending(false);
    }
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  async function disconnect() {
    setDisconnecting(true);
    try {
      await apiDelete("/api/assistant/credentials");
      setStatus({ connected: false, demoAvailable: status?.demoAvailable ?? false });
      setHistory([]);
    } catch {
      // best-effort
    } finally {
      setDisconnecting(false);
    }
  }

  // ── Demo mode ─────────────────────────────────────────────────────────────

  function useDemo() {
    setStatus((prev) => ({
      connected: true,
      demoAvailable: prev?.demoAvailable ?? true,
      provider: "demo",
      model: "demo",
    }));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Width logic: expanded = full-viewport on lg, w-full on mobile; collapsed = 28rem lg
  const sizeClasses = expanded
    ? "left-0 w-auto"
    : "w-full lg:left-auto lg:w-[28rem]";

  const isConnected = status?.connected === true;
  const isDemoMode = isConnected && status?.provider === "demo";

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        role="dialog"
        aria-modal={false}
        aria-label="AI Assistant"
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex flex-col",
          "border-l border-border-subtle bg-canvas shadow-2xl",
          "transition-all duration-300",
          open ? "translate-x-0" : "translate-x-full pointer-events-none",
          sizeClasses,
        )}
      >
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
          <Sparkles className="h-4 w-4 text-accent" />
          <span className="flex-1 truncate font-mono text-sm font-semibold text-ink">
            AI Assistant
          </span>

          <div className="flex shrink-0 items-center gap-1">
            {/* Expand/collapse — desktop only */}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Collapse panel" : "Expand panel"}
              aria-pressed={expanded}
              className="hidden h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken lg:grid"
            >
              {expanded ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>

            {/* Close */}
            <button
              ref={closeBtnRef}
              type="button"
              onClick={() => {
                onClose();
                requestAnimationFrame(() => triggerRef?.current?.focus());
              }}
              aria-label="Close assistant panel"
              className="grid h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-1 flex-col">
          {loadingStatus ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="md" />
            </div>
          ) : !isConnected ? (
            /* Setup view */
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AssistantSetup
                demoAvailable={status?.demoAvailable ?? false}
                onConnected={(s) => setStatus(s)}
                onUseDemo={useDemo}
              />
            </div>
          ) : (
            /* Chat view */
            <>
              {/* Transcript */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                {history.length === 0 ? (
                  <WelcomeState />
                ) : (
                  <div className="flex flex-col gap-3">
                    {history.map((msg, i) => (
                      <MessageBubble key={i} msg={msg} />
                    ))}
                    {sending && (
                      <div className="flex items-center gap-2">
                        <div className="rounded-xl bg-sunken px-3 py-2">
                          <span className="flex items-center gap-1.5 font-mono text-xs text-ink-muted">
                            <Spinner size="sm" />
                            thinking…
                          </span>
                        </div>
                      </div>
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              {/* Error */}
              {sendError && (
                <div className="shrink-0 border-t border-border-subtle bg-danger/5 px-4 py-2">
                  <p className="font-mono text-xs text-danger">{sendError}</p>
                </div>
              )}

              {/* Input area */}
              <div className="shrink-0 border-t border-border-subtle p-3">
                <div className="flex items-end gap-2 rounded-xl border border-border-subtle bg-sunken px-3 py-2">
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Ask the assistant…"
                    rows={1}
                    className={cn(
                      "min-h-[36px] max-h-[120px] flex-1 resize-none bg-transparent text-sm text-ink placeholder:text-ink-muted",
                      "focus:outline-none",
                      "overflow-y-auto leading-relaxed",
                    )}
                    style={{ fieldSizing: "content" } as React.CSSProperties}
                    disabled={sending}
                  />
                  <button
                    type="button"
                    onClick={send}
                    disabled={!input.trim() || sending}
                    aria-label="Send message"
                    className={cn(
                      "grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      input.trim() && !sending
                        ? "bg-accent text-accent-ink hover:opacity-90"
                        : "bg-border-subtle text-ink-muted",
                    )}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1 text-center font-mono text-[10px] text-ink-muted">
                  Enter to send · Shift+Enter for newline
                </p>
              </div>
            </>
          )}
        </div>

        {/* ── Footer (when connected) ─────────────────────────────────────── */}
        {isConnected && !loadingStatus && (
          <div className="flex shrink-0 items-center justify-between border-t border-border-subtle bg-sunken px-4 py-2">
            <div className="flex items-center gap-2 min-w-0">
              {isDemoMode ? (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="font-mono text-[10px] text-ink-muted truncate">
                    demo key · rate-limited
                  </span>
                </>
              ) : (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span className="font-mono text-[10px] text-ink-muted truncate">
                    {status?.provider} · {status?.model}
                  </span>
                </>
              )}
            </div>
            <button
              onClick={disconnect}
              disabled={disconnecting}
              className="ml-2 shrink-0 font-mono text-[10px] text-ink-muted hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {disconnecting ? "…" : "disconnect"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
