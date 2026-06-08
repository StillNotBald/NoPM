"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Menu, PanelLeftClose, PanelLeft, X } from "lucide-react";
import { Sidebar } from "./sidebar";
import { cn } from "@/lib/cn";

// ── Inspector (right panel) context ─────────────────────────────────────────
type InspectorPayload = { title?: string; content: ReactNode };
const InspectorCtx = createContext<{
  open: (content: ReactNode, title?: string) => void;
  close: () => void;
}>({ open: () => {}, close: () => {} });
export const useInspector = () => useContext(InspectorCtx);

/**
 * Flexible 3-panel app shell (prior-console-app pattern, Apple-styled):
 *  • left  — collapsible nav (icon rail on desktop, drawer on mobile)
 *  • middle — page content
 *  • right — inspector panel (opened on demand; overlay below lg)
 * Fully responsive: mobile drawer + bottom-safe overlays.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop icon rail
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);

  return (
    <InspectorCtx.Provider
      value={{
        open: (content, title) => setInspector({ content, title }),
        close: () => setInspector(null),
      }}
    >
      <div className="flex h-screen overflow-hidden bg-canvas text-ink">
        {/* mobile nav backdrop */}
        {navOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}

        {/* sidebar: fixed drawer on mobile, static rail/full on desktop */}
        <div
          className={cn(
            "fixed z-40 h-full shrink-0 transition-transform duration-200 ease-out md:static md:translate-x-0 md:transition-[width]",
            navOpen ? "translate-x-0" : "-translate-x-full",
            collapsed ? "md:w-[64px]" : "md:w-60",
            "w-60",
          )}
        >
          <Sidebar collapsed={collapsed} onNavigate={() => setNavOpen(false)} />
        </div>

        {/* main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/80 px-3 backdrop-blur-xl">
            <button
              onClick={() => setNavOpen(true)}
              className="grid h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken md:hidden"
              aria-label="Open menu"
            >
              <Menu size={18} />
            </button>
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="hidden h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken md:grid"
              aria-label="Collapse sidebar"
            >
              {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <div className="flex-1" />
          </header>
          <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        </div>

        {/* inspector */}
        {inspector && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/20 backdrop-blur-sm lg:hidden"
              onClick={() => setInspector(null)}
            />
            <aside className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[400px] shrink-0 flex-col border-l border-border-subtle bg-surface shadow-lg lg:static lg:shadow-none">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle px-4">
                <span className="text-sm font-semibold text-ink">{inspector.title ?? "Details"}</span>
                <button
                  onClick={() => setInspector(null)}
                  className="grid h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                  aria-label="Close panel"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">{inspector.content}</div>
            </aside>
          </>
        )}
      </div>
    </InspectorCtx.Provider>
  );
}
