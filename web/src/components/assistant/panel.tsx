"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, ArrowUp, ExternalLink, Maximize2, Minimize2, Plus, ChevronLeft, MessageSquare } from "lucide-react";
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
  usedFallback?: boolean;
  streaming?: boolean; // true while tokens are still arriving
  // Sanitized mid-stream failure (LOCKED #6): render an inline retry
  // affordance instead of clearing the transcript or splicing fallback text
  // onto whatever content already streamed.
  error?: boolean;
}

interface ChatResponse {
  reply: string;
  actions: Action[];
  usedDemoKey: boolean;
  usedFallback?: boolean;
  // Demo sessions always get conversation_id: null (fresh chat every visit,
  // no persistence).
  conversation_id: string | null;
}

// ── NDJSON stream event types ─────────────────────────────────────────────────
type StreamEvent =
  | { type: "actions"; actions: Action[] }
  | { type: "token"; text: string }
  | { type: "done"; conversation_id: string | null; usedDemoKey: boolean; usedFallback?: boolean }
  | { type: "error"; message: string };

interface ConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
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

function MessageBubble({ msg, onRetry }: { msg: ChatMessage; onRetry?: () => void }) {
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
        {msg.content ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : null}
        {/* Streaming cursor — shown while tokens are still arriving */}
        {msg.streaming && (
          <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-muted">
            <Spinner size="sm" />
          </span>
        )}
      </div>

      {/* Inline error bubble — mid-stream {type:'error'}. The user's message
          stays in the transcript above; retry re-sends it in place. */}
      {msg.error && (
        <div className="flex max-w-[85%] flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
          <span className="font-mono text-xs text-danger">
            Something went wrong. Your message wasn&apos;t lost.
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-danger/40 px-3 font-mono text-xs font-semibold text-danger transition-colors hover:bg-danger/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            >
              Retry
            </button>
          )}
        </div>
      )}

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

// ── Conversation list ────────────────────────────────────────────────────────

function ConversationList({
  conversations,
  loading,
  onSelect,
  onNewChat,
}: {
  conversations: ConversationSummary[];
  loading: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 py-2">
        <p className="font-mono text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          Conversations
        </p>
        <button
          type="button"
          onClick={onNewChat}
          className="flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs text-ink-secondary hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="New chat"
        >
          <Plus className="h-3 w-3" />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="sm" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <MessageSquare className="h-6 w-6 text-ink-muted" />
            <p className="font-mono text-xs text-ink-muted">No conversations yet</p>
            <button
              type="button"
              onClick={onNewChat}
              className="mt-1 rounded-md bg-accent px-3 py-1.5 font-mono text-xs text-accent-ink hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Start a chat
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((conv) => (
              <li key={conv.id}>
                <button
                  type="button"
                  onClick={() => onSelect(conv.id)}
                  className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <p className="truncate font-mono text-xs font-medium text-ink">
                    {conv.title ?? "Untitled chat"}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-ink-muted">
                    {new Date(conv.updated_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function AssistantPanel({ open, onClose, triggerRef }: AssistantPanelProps) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Conversation state
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  // null = list view, string = chat view for that conversation, "new" = new chat
  const [view, setView] = useState<"list" | "chat">("list");

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
      setStatus({ connected: false, demoAvailable: false, demoSession: false });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchStatus();
    }
  }, [open, fetchStatus]);

  // ── Fetch conversations when connected ────────────────────────────────────

  const fetchConversations = useCallback(async () => {
    setLoadingConversations(true);
    try {
      const data = await apiGet<ConversationSummary[]>("/api/assistant/conversations");
      setConversations(data ?? []);
    } catch {
      // silently ignore; empty list
      setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  // Demo-login visitors (one-click "try the live demo") are always
  // connected-in-demo-mode: they never see the setup gate and never get a
  // saved-conversation list (LOCKED: fresh chat every visit, no migration).
  const isDemoSession = status?.demoSession === true;
  const isConnected = status?.connected === true || isDemoSession;

  useEffect(() => {
    // Demo sessions never have a conversation list to fetch.
    if (open && isConnected && !isDemoSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchConversations();
    }
  }, [open, isConnected, isDemoSession, fetchConversations]);

  // Reset to list view when panel opens
  useEffect(() => {
    if (open && isConnected) {
      // Stay in current view — only reset if panel was closed
    }
  }, [open, isConnected]);

  // ── Load conversation messages ────────────────────────────────────────────

  const loadConversation = useCallback(async (id: string) => {
    try {
      const data = await apiGet<{
        conversation: ConversationSummary;
        messages: Array<{ id: string; role: "user" | "assistant"; content: string; actions?: Action[] | null; created_at: string }>;
      }>(`/api/assistant/conversations/${id}`);

      const msgs: ChatMessage[] = (data.messages ?? []).map((m) => ({
        role: m.role,
        content: m.content,
        actions: m.actions ?? undefined,
      }));
      setHistory(msgs);
      setActiveConversationId(id);
      setView("chat");
    } catch {
      // Fallback: start fresh if load fails
      setHistory([]);
      setActiveConversationId(null);
      setView("chat");
    }
  }, []);

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

  // ── New chat ──────────────────────────────────────────────────────────────

  function startNewChat() {
    setHistory([]);
    setActiveConversationId(null);
    setInput("");
    setSendError(null);
    setView("chat");
  }

  // ── Back to list ──────────────────────────────────────────────────────────

  function backToList() {
    setView("list");
    fetchConversations();
  }

  // ── Send message (streaming, with JSON fallback) ─────────────────────────

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    const contextHistory = history; // prior turns only — this turn's message travels separately
    setHistory((h) => [...h, { role: "user", content: text }]);
    setInput("");

    await dispatchSend(text, contextHistory, {
      onTotalFailure: () => {
        // Pure transport failure (streaming AND the JSON fallback both
        // failed) — pre-existing UX: drop the optimistic bubble and hand
        // the text back to the input so the user can edit/resend.
        setHistory((h) => h.slice(0, -1));
        setInput(text);
      },
    });
  }

  // Re-sends the user message that preceded an inline error bubble
  // (mid-stream {type:'error'}, LOCKED #6) at `assistantIdx`. The user's
  // message stays in the transcript throughout — never cleared, and the
  // input box (whatever the user may be typing next) is never touched.
  async function retryMessage(assistantIdx: number) {
    if (sending) return;
    // Defensive: retry truncates everything after assistantIdx, so only
    // proceed if it's still the last turn (mirrors the UI guard on the
    // Retry button itself — never discard newer messages).
    if (assistantIdx !== history.length - 1) return;
    const userIdx = assistantIdx - 1;
    const userMsg = history[userIdx];
    if (!userMsg || userMsg.role !== "user") return;

    const contextHistory = history.slice(0, userIdx);
    setHistory((h) => h.slice(0, assistantIdx)); // drop the errored bubble only
    await dispatchSend(userMsg.content, contextHistory);
  }

  async function dispatchSend(
    text: string,
    contextHistory: ChatMessage[],
    opts: { onTotalFailure?: () => void } = {},
  ) {
    setSending(true);
    setSendError(null);

    const apiHistory = contextHistory.map((m) => ({ role: m.role, content: m.content }));
    const requestBody: Record<string, unknown> = {
      message: text,
      history: apiHistory,
      stream: true,
    };
    if (activeConversationId) {
      requestBody.conversation_id = activeConversationId;
    }

    try {
      // ── Attempt streaming ────────────────────────────────────────────────
      await sendStreaming(requestBody);
    } catch {
      // Transport-level failure only — a sanitized {type:'error'} NDJSON
      // event is handled inline inside sendStreaming and never reaches this
      // catch (LOCKED #6: never splice fallback text onto a partial reply).
      try {
        const fallbackBody = { ...requestBody, stream: false };
        await sendJson(fallbackBody);
      } catch (e: unknown) {
        setSendError(e instanceof Error ? e.message : "Failed to send message.");
        opts.onTotalFailure?.();
      }
    } finally {
      setSending(false);
    }
  }

  async function sendStreaming(requestBody: Record<string, unknown>) {
    const res = await fetch("/api/assistant/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Placeholder message that we'll update progressively.
    // We read history.length at call-time (the user message was already appended
    // by send(), so the placeholder is at history.length after that append).
    // React state batching means we use a ref-free positional index.
    let placeholderIdx = -1;
    setHistory((h) => {
      placeholderIdx = h.length;
      return [...h, { role: "assistant" as const, content: "", streaming: true }];
    });

    let accText = "";
    let pendingActions: Action[] | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(trimmed) as StreamEvent;
          } catch {
            continue; // skip malformed lines
          }

          if (event.type === "error") {
            // Sanitized mid-stream (or pre-flush) failure. Do NOT throw —
            // throwing would fall through to the JSON fallback in
            // dispatchSend and risk splicing a second reply onto whatever
            // partial text already streamed (LOCKED #6). Finalize the
            // placeholder as an inline error bubble with a retry
            // affordance instead; the user's message stays put.
            setHistory((h) =>
              h.map((m, i) =>
                i === placeholderIdx
                  ? {
                      ...m,
                      content: accText,
                      actions: pendingActions ?? m.actions,
                      streaming: false,
                      error: true,
                    }
                  : m,
              ),
            );
            return;
          } else if (event.type === "actions") {
            pendingActions = event.actions;
            // Update the placeholder with actions so chips appear before text finishes
            setHistory((h) =>
              h.map((m, i) =>
                i === placeholderIdx ? { ...m, actions: event.actions } : m,
              ),
            );
          } else if (event.type === "token") {
            accText += event.text;
            setHistory((h) =>
              h.map((m, i) =>
                i === placeholderIdx ? { ...m, content: accText } : m,
              ),
            );
          } else if (event.type === "done") {
            // Finalize the message
            if (event.conversation_id && event.conversation_id !== activeConversationId) {
              setActiveConversationId(event.conversation_id);
            }
            setHistory((h) =>
              h.map((m, i) =>
                i === placeholderIdx
                  ? {
                      ...m,
                      content: accText || "Done.",
                      actions: pendingActions ?? m.actions,
                      usedDemoKey: event.usedDemoKey,
                      usedFallback: event.usedFallback,
                      streaming: false,
                    }
                  : m,
              ),
            );
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Ensure streaming flag is cleared
    setHistory((h) =>
      h.map((m, i) => (i === placeholderIdx ? { ...m, streaming: false } : m)),
    );
  }

  async function sendJson(requestBody: Record<string, unknown>) {
    const res = await apiPost<ChatResponse>("/api/assistant/chat", requestBody);

    if (res.conversation_id && res.conversation_id !== activeConversationId) {
      setActiveConversationId(res.conversation_id);
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: res.reply,
      actions: res.actions,
      usedDemoKey: res.usedDemoKey,
      usedFallback: res.usedFallback,
    };
    setHistory((h) => [...h, assistantMsg]);
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  async function disconnect() {
    setDisconnecting(true);
    try {
      await apiDelete("/api/assistant/credentials");
      setStatus({
        connected: false,
        demoAvailable: status?.demoAvailable ?? false,
        demoSession: status?.demoSession ?? false,
      });
      setHistory([]);
      setActiveConversationId(null);
      setConversations([]);
      setView("list");
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
      demoSession: prev?.demoSession ?? false,
      provider: "demo",
      model: "demo",
    }));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const sizeClasses = expanded
    ? "left-0 w-auto"
    : "w-full lg:left-auto lg:w-[28rem]";

  const isDemoMode = isConnected && (status?.provider === "demo" || isDemoSession);
  // Demo-session visitors always land straight in the chat view — no
  // saved-conversation list exists for them (fresh chat every visit).
  const inChatView = isConnected && (isDemoSession || view === "chat");

  // Transparency badge (change #2): reflects the MOST RECENT assistant
  // reply — adapts from "demo model" to "grounded fallback" when the last
  // reply actually used the deterministic read-only fallback.
  const lastAssistantMessage = [...history].reverse().find((m) => m.role === "assistant");
  const lastUsedFallback = lastAssistantMessage?.usedFallback === true;

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
        data-shell-chrome
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
          {/* Back button — only in chat view when connected. Hidden for demo
              sessions: there is no conversation list to go back to (fresh
              chat every visit, no "previous conversations" affordance). */}
          {inChatView && !isDemoSession && (
            <button
              type="button"
              onClick={backToList}
              aria-label="Back to conversations"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}

          {!inChatView && <Sparkles className="h-4 w-4 text-accent" />}

          <span className="flex-1 truncate font-mono text-sm font-semibold text-ink">
            {inChatView ? "Chat" : "AI Assistant"}
          </span>

          <div className="flex shrink-0 items-center gap-1">
            {/* New chat button — in chat view */}
            {inChatView && (
              <button
                type="button"
                onClick={startNewChat}
                aria-label="New chat"
                className="grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}

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
              className="grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
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
          ) : !isDemoSession && view === "list" ? (
            /* Conversation list view — never shown for demo sessions (fresh
               chat every visit, no saved-conversation list). */
            <ConversationList
              conversations={conversations}
              loading={loadingConversations}
              onSelect={(id) => loadConversation(id)}
              onNewChat={startNewChat}
            />
          ) : (
            /* Chat view */
            <>
              {/* Transcript */}
              <div
                role="log"
                aria-live="polite"
                aria-label="Assistant conversation"
                className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
              >
                {history.length === 0 ? (
                  <WelcomeState />
                ) : (
                  <div className="flex flex-col gap-3">
                    {history.map((msg, i) => (
                      <MessageBubble
                        key={i}
                        msg={msg}
                        // Retry truncates everything after the errored bubble
                        // (it re-runs that turn in place), so it's only wired
                        // up while the error is still the LAST turn — if the
                        // user has since sent a newer message, retrying the
                        // older error must not be able to discard it.
                        onRetry={msg.error && i === history.length - 1 ? () => retryMessage(i) : undefined}
                      />
                    ))}
                    {/* "thinking…" only while no streaming bubble is visible yet */}
                    {sending && !history.some((m) => m.streaming) && (
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
                <p className="mt-1 text-center font-mono text-xs text-ink-muted">
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
              {lastUsedFallback ? (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="font-mono text-xs text-ink-muted truncate">
                    Grounded fallback — read-only live workspace data
                  </span>
                </>
              ) : isDemoMode ? (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                  <span className="font-mono text-xs text-ink-muted truncate">
                    Demo model — grounded in live workspace data
                  </span>
                </>
              ) : (
                <>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  <span className="font-mono text-xs text-ink-muted truncate">
                    {status?.provider} · {status?.model}
                  </span>
                </>
              )}
            </div>
            {/* Disconnect is meaningless for demo sessions — there is no
                stored credential to disconnect from, and the gate can't be
                un-skipped for the shared demo login. */}
            {!isDemoSession && (
              <button
                onClick={disconnect}
                disabled={disconnecting}
                className="ml-2 shrink-0 font-mono text-xs text-ink-muted hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {disconnecting ? "…" : "disconnect"}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
