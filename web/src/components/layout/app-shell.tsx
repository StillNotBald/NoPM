"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { PanelLeftClose, PanelLeft, X } from "lucide-react";
import { Sidebar } from "./sidebar";
import { BottomNav } from "./bottom-nav";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "@/lib/cn";
import { CommandPalette, CmdKTrigger } from "@/components/command-palette";

// ── Inspector (right panel) context ─────────────────────────────────────────
type InspectorPayload = { title?: string; content: ReactNode };
const InspectorCtx = createContext<{
  open: (content: ReactNode, title?: string) => void;
  close: () => void;
}>({ open: () => {}, close: () => {} });
export const useInspector = () => useContext(InspectorCtx);

/**
 * Adaptive shell (Apple-styled):
 *  • desktop (lg+): left sidebar (collapsible) · content · right inspector
 *  • mobile/tablet (<lg): NO sidebar — a bottom tab bar; inspector becomes a full-screen sheet
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const openCmd = useCallback(() => setCmdOpen(true), []);

  return (
    <InspectorCtx.Provider
      value={{
        open: (content, title) => setInspector({ content, title }),
        close: () => setInspector(null),
      }}
    >
      <div className="flex h-dvh overflow-hidden bg-canvas text-ink">
        {/* sidebar — desktop only */}
        <div
          className={cn(
            "hidden shrink-0 lg:block lg:transition-[width]",
            collapsed ? "lg:w-[64px]" : "lg:w-60",
          )}
        >
          <Sidebar collapsed={collapsed} />
        </div>

        {/* main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/80 px-3 backdrop-blur-xl sm:px-4">
            {/* macOS window chrome — terminal motif */}
            <div className="hidden items-center gap-2 pr-1 sm:flex" aria-hidden>
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840]" />
            </div>
            {/* brand shown when there's no sidebar (mobile/tablet) */}
            <div className="flex items-center gap-1.5 lg:hidden">
              <span className="inline-block h-4 w-[3px] animate-pulse rounded-[1px] bg-accent" />
              <span className="font-mono font-semibold tracking-tight text-ink">nopm</span>
            </div>
            {/* collapse toggle — desktop only */}
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="hidden h-10 w-10 place-items-center rounded-md text-ink-secondary hover:bg-sunken lg:grid"
              aria-label="Collapse sidebar"
            >
              {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <div className="flex-1" />
            {/* live indicator */}
            <span className="mr-1 hidden items-center gap-1.5 font-mono text-xs text-ink-muted sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              live
            </span>
            <ThemeToggle />
            <CmdKTrigger onClick={openCmd} />
          </header>

          {/* content — grouped grey bg so white cards lift off it (iOS layering);
              pad bottom on mobile so the bottom nav never covers it */}
          <main className="min-h-0 flex-1 overflow-auto bg-grouped pb-20 lg:pb-0">{children}</main>
        </div>

        {/* command palette — singleton, Cmd/Ctrl-K */}
        <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

        {/* bottom nav — mobile + tablet */}
        <BottomNav />

        {/* inspector — full-screen sheet on mobile, right column on lg+ */}
        {inspector && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
              onClick={() => setInspector(null)}
            />
            <aside className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-border-subtle bg-surface shadow-lg sm:w-[420px] lg:static lg:z-auto lg:w-[400px] lg:shadow-none">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-4">
                <span className="text-sm font-semibold text-ink">{inspector.title ?? "Details"}</span>
                <button
                  onClick={() => setInspector(null)}
                  className="grid h-10 w-10 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                  aria-label="Close panel"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {inspector.content}
              </div>
            </aside>
          </>
        )}
      </div>
    </InspectorCtx.Provider>
  );
}
