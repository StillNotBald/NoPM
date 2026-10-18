"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  useBodyScrollLock,
  useEscapeClose,
  useFocusTrap,
  useInertShell,
  useReturnFocus,
} from "@/lib/hooks/use-sheet";

type ModalOpts = {
  title?: string;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Sticky footer slot for a primary action (e.g. Save/Cancel). */
  footer?: ReactNode;
};
type ModalEntry = { node: ReactNode; opts: ModalOpts };

const ModalCtx = createContext<{
  open: (node: ReactNode, opts?: ModalOpts) => void;
  close: () => void;
}>({ open: () => {}, close: () => {} });

export const useModal = () => useContext(ModalCtx);

const sizes: Record<NonNullable<ModalOpts["size"]>, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  xl: "sm:max-w-4xl",
  full: "sm:max-w-6xl",
};

/**
 * Stacked, responsive modal host (bottom-sheet on mobile, centered card on
 * desktop). Body scroll is locked and the app shell marked `inert` below lg
 * while any modal is open (useBodyScrollLock / useInertShell — F1); at EVERY
 * width Tab is trapped inside the dialog (useFocusTrap), Escape closes the
 * top-most overlay only (useEscapeClose), focus moves to the close button on
 * open (and again whenever a new modal is pushed on top) and returns to the
 * opener once the whole stack empties (useReturnFocus).
 */
export function ModalProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const open = useCallback(
    (node: ReactNode, opts: ModalOpts = {}) => setStack((s) => [...s, { node, opts }]),
    [],
  );
  const close = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  // Stable identity: every useModal() consumer would otherwise re-render on any stack change.
  const api = useMemo(() => ({ open, close }), [open, close]);
  const top = stack[stack.length - 1];
  const isOpen = stack.length > 0;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useBodyScrollLock(isOpen);
  useInertShell(isOpen);
  useEscapeClose(isOpen, close);
  useFocusTrap(dialogRef, isOpen);
  useReturnFocus(isOpen, closeBtnRef);

  // Refocus the close button whenever the visible top-most modal changes
  // (a new one pushed on top, or popped back to the one beneath) — not just
  // on the initial empty -> non-empty transition, which useReturnFocus covers.
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen, stack.length]);

  const title = top?.opts.title;

  return (
    <ModalCtx.Provider value={api}>
      {children}
      {top && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <div className="absolute inset-0 bg-black/30" onClick={close} />
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={title ? undefined : "Dialog"}
            className={cn(
              "relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-surface shadow-lg focus:outline-none sm:rounded-xl",
              sizes[top.opts.size ?? "md"],
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-5 pt-[env(safe-area-inset-top)]">
              {title ? (
                <h2 id={titleId} className="text-base font-semibold text-ink">
                  {title}
                </h2>
              ) : (
                <span />
              )}
              <button
                ref={closeBtnRef}
                type="button"
                onClick={close}
                className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-well"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>
            <div
              className={cn(
                "min-h-0 flex-1 overflow-auto p-5",
                !top.opts.footer && "pb-[max(1.25rem,env(safe-area-inset-bottom))]",
              )}
            >
              {top.node}
            </div>
            {top.opts.footer && (
              <div className="shrink-0 border-t border-border-subtle p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                {top.opts.footer}
              </div>
            )}
          </div>
        </div>
      )}
    </ModalCtx.Provider>
  );
}
