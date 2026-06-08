"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type ModalOpts = { title?: string; size?: "sm" | "md" | "lg" | "xl" | "full" };
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

/** Stacked, responsive modal host (bottom-sheet on mobile, centered card on desktop). */
export function ModalProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<ModalEntry[]>([]);
  const open = (node: ReactNode, opts: ModalOpts = {}) =>
    setStack((s) => [...s, { node, opts }]);
  const close = () => setStack((s) => s.slice(0, -1));
  const top = stack[stack.length - 1];

  return (
    <ModalCtx.Provider value={{ open, close }}>
      {children}
      {top && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={close} />
          <div
            className={cn(
              "relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-surface shadow-lg sm:rounded-2xl",
              sizes[top.opts.size ?? "md"],
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-5">
              <h2 className="text-base font-semibold text-ink">{top.opts.title ?? ""}</h2>
              <button
                onClick={close}
                className="grid h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-5">{top.node}</div>
          </div>
        </div>
      )}
    </ModalCtx.Provider>
  );
}
