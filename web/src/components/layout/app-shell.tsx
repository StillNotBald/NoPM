"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { PanelLeftClose, PanelLeft, Sparkles } from "lucide-react";
import { Sidebar } from "./sidebar";
import { BottomNav } from "./bottom-nav";
import { Breadcrumbs } from "./breadcrumbs";
import { ThemeToggle } from "./theme-toggle";
import { AccountMenu } from "./account-menu";
import { NotificationBell } from "@/components/notifications/bell";
import { cn } from "@/lib/cn";
import { CommandPalette, CmdKTrigger, CmdKTriggerMobile } from "@/components/command-palette";
import { RightPushPanel, PUSH_MARGIN, PUSH_MARGIN_NONE } from "@/components/ui/right-push-panel";
import { AssistantPanel } from "@/components/assistant/panel";
import { TrafficLights } from "@/components/ui/terminal-card";
import { ToastProvider } from "@/components/ui/toast";
import type { NavMode } from "@/lib/nav/nav-mode";
import type { PendingCounts } from "@/lib/governance/pending-counts";
import { PageHint } from "@/components/onboarding/page-hint";

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
export function AppShell({
  children,
  initialNavMode = "all",
  pendingCounts = null,
}: {
  children: ReactNode;
  /** Server-resolved sidebar mode (R-78) — defaults to "all" so any other caller is unaffected. */
  initialNavMode?: NavMode;
  /** Server-computed governance queue counts for the nav badges (fail-soft). */
  pendingCounts?: PendingCounts | null;
}) {
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
      <div data-shell-root className="flex h-dvh overflow-hidden bg-canvas text-ink">
        {/* data-app-shell — the background region made `inert` while a sheet
            (RightPushPanel/Modal) is open below lg (useInertShell). Scoped to
            sidebar + header + content + bottom nav; the overlay layers below
            (CommandPalette, RightPushPanel, AssistantPanel) live OUTSIDE this
            wrapper so a sheet never inerts itself. */}
        <div data-app-shell className="flex min-w-0 flex-1">
          {/* sidebar — desktop only */}
          <div
            data-shell-chrome
            className={cn(
              "hidden shrink-0 lg:block lg:transition-[width]",
              collapsed ? "lg:w-[64px]" : "lg:w-60",
            )}
          >
            <Sidebar collapsed={collapsed} initialNavMode={initialNavMode} pendingCounts={pendingCounts} />
          </div>

          {/* main column — margin pushed right when panel is open on desktop */}
          <div
            data-shell-column
            className={cn(
              "flex min-w-0 flex-1 flex-col",
              isOpen && !expanded ? PUSH_MARGIN : PUSH_MARGIN_NONE,
            )}
          >
            <header data-shell-chrome className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas/80 px-3 backdrop-blur-xl sm:px-4">
              {/* macOS window chrome — terminal motif */}
              <div className="hidden pr-1 sm:flex">
                <TrafficLights size="md" />
              </div>
              {/* brand shown when there's no sidebar (mobile/tablet) */}
              <div className="flex items-center gap-1.5 lg:hidden">
                <span className="inline-block h-4 w-[3px] animate-pulse motion-reduce:animate-none rounded-[1px] bg-accent" />
                <span className="font-mono font-semibold tracking-tight text-ink">nopm</span>
              </div>
              {/* collapse toggle — desktop only (44px tap area below lg is a no-op
                  today since the button is display:none there; kept consistent
                  with the rest of the header chrome for when that changes) */}
              <button
                onClick={() => setCollapsed((v) => !v)}
                className="hidden h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken lg:grid lg:h-10 lg:w-10"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
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
                  "relative grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken",
                  "lg:h-10 lg:w-10",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  assistantOpen && "bg-sunken text-accent",
                )}
              >
                <Sparkles size={18} />
              </button>
              <NotificationBell />
              <ThemeToggle />
              {/* search entry — icon-only below sm, the existing "run command" pill sm+ */}
              <CmdKTriggerMobile onClick={openCmd} />
              <CmdKTrigger onClick={openCmd} />
              <AccountMenu />
            </header>

            {/* wayfinding breadcrumbs — slim bar between header and content */}
            <Breadcrumbs />

            {/* R-78 — one-line dismissible "what is this page for" strip; renders
                nothing on pages without a registry entry (dashboard/start). */}
            <PageHint />

            {/* content — grouped grey bg so white cards lift off it (iOS layering);
                pad bottom on mobile so the bottom nav never covers it */}
            <main data-shell-main className="min-h-0 flex-1 overflow-auto bg-grouped pb-20 lg:pb-0">
              {children}
            </main>
          </div>

          {/* bottom nav — mobile + tablet */}
          <BottomNav pendingCounts={pendingCounts} />
        </div>

        {/* command palette — singleton, Cmd/Ctrl-K — outside data-app-shell so
            Cmd/Ctrl-K still works while another sheet is open */}
        <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />

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
