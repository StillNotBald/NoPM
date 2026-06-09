"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { PanelLeftClose, PanelLeft, Sparkles } from "lucide-react";
import { Sidebar } from "./sidebar";
import { BottomNav } from "./bottom-nav";
import { ThemeToggle } from "./theme-toggle";
import { NotificationBell } from "@/components/notifications/bell";
import { cn } from "@/lib/cn";
import { CommandPalette, CmdKTrigger } from "@/components/command-palette";
import { RightPushPanel, PUSH_MARGIN, PUSH_MARGIN_NONE } from "@/components/ui/right-push-panel";
import { AssistantPanel } from "@/components/assistant/panel";
import { ToastProvider } from "@/components/ui/toast";

// ── Inspector (right push-panel) context ──────────────────────────────────────

type InspectorPayload = { title: string; content: ReactNode };

const InspectorCtx = createContext<{
  open: (content: ReactNode, title?: string) => void;
  close: () => void;
}>({ open: () => {}, close: () => {} });

export const useInspector = () => useContext(InspectorCtx);

/**
 * Adaptive shell (Apple-styled):
 *  - desktop (lg+): left sidebar (collapsible) · content column · right push-panel
 *    The push-panel SLIDES IN from the right and PUSHES the content column left
 *    via `lg:mr-[28rem]` — no backdrop, no overlay on desktop.
 *  - mobile/tablet (<lg): NO sidebar — bottom tab bar; panel becomes a full-screen sheet.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const openCmd = useCallback(() => setCmdOpen(true), []);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);

  const isOpen = inspector !== null;

  return (
    <ToastProvider>
    <InspectorCtx.Provider
      value={{
        open: (content, title) => {
          setInspector({ content, title: title ?? "Details" });
          setExpanded(false);
        },
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

        {/* main column — margin pushed right when panel is open on desktop */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            isOpen && !expanded ? PUSH_MARGIN : PUSH_MARGIN_NONE,
          )}
        >
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
            <button
              ref={assistantTriggerRef}
              onClick={() => setAssistantOpen((v) => !v)}
              aria-label="Open AI assistant"
              aria-pressed={assistantOpen}
              className={cn(
                "relative grid h-10 w-10 place-items-center rounded-md text-ink-secondary hover:bg-sunken",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                assistantOpen && "bg-sunken text-accent",
              )}
            >
              <Sparkles size={18} />
            </button>
            <NotificationBell />
            <ThemeToggle />
            <CmdKTrigger onClick={openCmd} />
          </header>

          {/* content — grouped grey bg so white cards lift off it (iOS layering);
              pad bottom on mobile so the bottom nav never covers it */}
          <main className="min-h-0 flex-1 overflow-auto bg-grouped pb-20 lg:pb-0">
            {children}
          </main>
        </div>

        {/* command palette — singleton, Cmd/Ctrl-K */}
        <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

        {/* bottom nav — mobile + tablet */}
        <BottomNav />

        {/* right push-panel — full-screen sheet on mobile, push-column on lg+ */}
        <RightPushPanel
          open={isOpen}
          onClose={() => setInspector(null)}
          title={inspector?.title ?? "Details"}
          expanded={expanded}
          onToggleExpand={() => setExpanded((v) => !v)}
        >
          {inspector?.content}
        </RightPushPanel>

        {/* AI assistant panel */}
        <AssistantPanel
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          triggerRef={assistantTriggerRef}
        />
      </div>
    </InspectorCtx.Provider>
    </ToastProvider>
  );
}
