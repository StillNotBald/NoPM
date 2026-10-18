"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// ── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "info";

interface ToastOptions {
  /** Override the auto-dismiss duration in ms. Default 3500; errors default to 8000. */
  duration?: number;
}

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastAPI {
  success(message: string, opts?: ToastOptions): void;
  error(message: string, opts?: ToastOptions): void;
  info(message: string, opts?: ToastOptions): void;
}

/** One announcement for the persistent live regions; `id` forces a re-announce of identical text. */
interface Announcement {
  id: string;
  text: string;
}

// ── Context ──────────────────────────────────────────────────────────────────

const ToastCtx = createContext<ToastAPI>({
  success: () => {},
  error: () => {},
  info: () => {},
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_DURATION = 3500;
// Errors carry the recovery step; give people time to read them (WCAG 2.2.1).
const ERROR_DURATION = 8000;
// After a hover/focus pause, never resume with less than this left.
const MIN_RESUME = 1500;

const variantStyles: Record<ToastVariant, string> = {
  success: "bg-surface border-success/30 text-ink",
  error: "bg-surface border-danger/30 text-ink",
  info: "bg-surface border-info/30 text-ink",
};

const variantIcon: Record<ToastVariant, ReactNode> = {
  success: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-success-ink"
    >
      <path
        d="M13.5 4.5L6.5 11.5L2.5 7.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  error: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-danger-ink"
    >
      <path
        d="M12 4L4 12M4 4l8 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  info: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-info-ink"
    >
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M8 7v4M8 5.5v.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  ),
};

// ── Single toast item ────────────────────────────────────────────────────────

/**
 * Visual tile only. Screen readers hear the message through the persistent
 * live regions in <Toaster> (a live region that is inserted together with its
 * content is often not announced). The auto-dismiss timer pauses while the
 * pointer is over the tile or keyboard focus is inside it.
 */
function ToastTile({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(item.duration);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismiss(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(MIN_RESUME, remaining.current - (Date.now() - startedAt));
    };
  }, [paused, item.id, onDismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex w-full max-w-xs items-start gap-3 rounded-lg border px-4 py-3",
        "shadow-md",
        variantStyles[item.variant],
      )}
    >
      <span className="mt-px">{variantIcon[item.variant]}</span>
      <p className="min-w-0 flex-1 text-sm leading-snug">{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="focus-ring -my-3 -mr-3 ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-well hover:text-ink sm:-my-1.5 sm:-mr-2 sm:h-8 sm:w-8"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Toaster stack ────────────────────────────────────────────────────────────

function Toaster({
  items,
  polite,
  assertive,
  onDismiss,
}: {
  items: ToastItem[];
  polite: Announcement | null;
  assertive: Announcement | null;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        // bottom-right on desktop, bottom-center on mobile.
        // Below lg the bottom tab bar (BottomNav) + iOS home-indicator safe
        // area sit under bottom-4 — offset by the same ~5rem clearance
        // app-shell.tsx reserves for it (<main> pb-20) plus the safe-area
        // inset, matching the pattern in bottom-nav.tsx / right-push-panel.tsx.
        // lg+ is pixel-identical to before (bottom-4, no bottom nav).
        "pointer-events-none fixed bottom-[calc(5rem_+_env(safe-area-inset-bottom))] right-4 z-[9999] lg:bottom-4",
        "flex flex-col-reverse items-end gap-2",
        // mobile: center + full-width toasts
        "max-sm:right-0 max-sm:left-0 max-sm:items-center max-sm:px-4",
      )}
    >
      {/* Persistent live regions: always mounted so the first announcement is
          not lost; the span key makes a repeated message announce again. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite && <span key={polite.id}>{polite.text}</span>}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive && <span key={assertive.id}>{assertive.text}</span>}
      </div>
      {items.map((item) => (
        <ToastTile key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * Mount once in the app shell. All client children can then call useToast().
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [polite, setPolite] = useState<Announcement | null>(null);
  const [assertive, setAssertive] = useState<Announcement | null>(null);
  // Use a counter ref for stable IDs without re-render cost.
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, variant: ToastVariant, opts?: ToastOptions) => {
    const id = `toast-${++counter.current}`;
    const duration = opts?.duration ?? (variant === "error" ? ERROR_DURATION : DEFAULT_DURATION);
    setItems((prev) => [...prev, { id, message, variant, duration }]);
    const announcement = { id, text: message };
    if (variant === "error") setAssertive(announcement);
    else setPolite(announcement);
  }, []);

  // Stable identity: every consumer of useToast() (27 files) otherwise
  // re-renders whenever the toast list changes.
  const api = useMemo<ToastAPI>(
    () => ({
      success: (msg, opts) => push(msg, "success", opts),
      error: (msg, opts) => push(msg, "error", opts),
      info: (msg, opts) => push(msg, "info", opts),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <Toaster items={items} polite={polite} assertive={assertive} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns { success, error, info } — call them anywhere inside ToastProvider.
 */
export function useToast(): ToastAPI {
  return useContext(ToastCtx);
}
