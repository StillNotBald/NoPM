"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// ── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "info";

interface ToastOptions {
  /** Override the auto-dismiss duration in ms. Default 3500. */
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

// ── Context ──────────────────────────────────────────────────────────────────

const ToastCtx = createContext<ToastAPI>({
  success: () => {},
  error: () => {},
  info: () => {},
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const variantStyles: Record<ToastVariant, string> = {
  success:
    "bg-surface border-success/30 text-ink [--icon-color:theme(colors.success)]",
  error:
    "bg-surface border-danger/30 text-ink [--icon-color:theme(colors.danger)]",
  info:
    "bg-surface border-info/30 text-ink [--icon-color:theme(colors.info)]",
};

const variantIcon: Record<ToastVariant, ReactNode> = {
  success: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className="shrink-0 text-success"
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
      className="shrink-0 text-danger"
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
      className="shrink-0 text-info"
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

function ToastTile({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    onDismiss(item.id);
  }, [item.id, onDismiss]);

  // Start the auto-dismiss timer via a layout effect equivalent on mount.
  // Using a ref-based callback avoids stale closures.
  const startTimer = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      timerRef.current = setTimeout(dismiss, item.duration);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id],
  );

  return (
    <div
      ref={startTimer}
      role="status"
      // polite for success/info, assertive for error
      aria-live={item.variant === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "pointer-events-auto flex w-full max-w-xs items-start gap-3 rounded-lg border px-4 py-3",
        "shadow-md backdrop-blur-sm",
        "animate-in slide-in-from-bottom-4 fade-in duration-200",
        variantStyles[item.variant],
      )}
    >
      <span className="mt-px">{variantIcon[item.variant]}</span>
      <p className="min-w-0 flex-1 text-sm leading-snug">{item.message}</p>
      <button
        onClick={dismiss}
        aria-label="Dismiss notification"
        className="ml-auto shrink-0 rounded p-0.5 text-ink-muted hover:bg-sunken hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Toaster stack ────────────────────────────────────────────────────────────

function Toaster({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div
      aria-label="Notifications"
      className={cn(
        // bottom-right on desktop, bottom-center on mobile
        "pointer-events-none fixed bottom-4 right-4 z-[9999]",
        "flex flex-col-reverse items-end gap-2",
        // mobile: center + full-width toasts
        "max-sm:right-0 max-sm:left-0 max-sm:items-center max-sm:px-4",
      )}
    >
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
  // Use a counter ref for stable IDs without re-render cost.
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, variant: ToastVariant, opts?: ToastOptions) => {
    const id = `toast-${++counter.current}`;
    setItems((prev) => [...prev, { id, message, variant, duration: opts?.duration ?? 3500 }]);
  }, []);

  const api: ToastAPI = {
    success: (msg, opts) => push(msg, "success", opts),
    error: (msg, opts) => push(msg, "error", opts),
    info: (msg, opts) => push(msg, "info", opts),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <Toaster items={items} onDismiss={dismiss} />
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
