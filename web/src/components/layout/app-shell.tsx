"use client";

import { createContext, Fragment, useContext, useState, useCallback, useMemo, useRef, type ReactNode } from "react";
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
import { IconButton } from "@/components/ui/icon-button";
import { TrafficLights } from "@/components/ui/terminal-card";
import { ToastProvider } from "@/components/ui/toast";
import type { NavMode } from "@/lib/nav/nav-mode";
import type { PendingCounts } from "@/lib/governance/pending-counts";
import { PageHint } from "@/components/onboarding/page-hint";
import type { PrefsSeed } from "@/lib/onboarding/seed";
import { MAIN_CONTENT_ID } from "@/lib/hooks/use-sheet";

// ── Inspector (right push-panel) context ──────────────────────────────────────

// `seq` is bumped on every open: it keys the content so React remounts it. Without it,
// opening the same form type for a different record while the panel is open (lg+,
// non-modal) reuses the instance, so "Edit task B" shows (and saves) task A's values.
type InspectorPayload = { title: string; content: ReactNode; seq: number };

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
  onboardingSeed = null,
}: {
  children: ReactNode;
  /** Server-resolved sidebar mode (R-78) — defaults to "all" so any other caller is unaffected. */
  initialNavMode?: NavMode;
  /** Server-computed governance queue counts for the nav badges (fail-soft). */
  pendingCounts?: PendingCounts | null;
  /** Server-resolved onboarding state for the page-hint strip (null = wait for the client store). */
  onboardingSeed?: PrefsSeed | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const inspectorSeq = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const openCmd = useCallback(() => setCmdOpen(true), []);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantTriggerRef = useRef<HTMLButtonElement>(null);

  const isOpen = inspector !== null;

  // Stable identity: ~55 call sites hold useInspector(); an inline object
  // would re-render all of them whenever the palette opens or the sidebar collapses.
  const inspectorApi = useMemo(
    () => ({
      open: (content: ReactNode, title?: string) => {
        setInspector({ content, title: title ?? "Details", seq: ++inspectorSeq.current });
        setExpanded(false);
      },
      close: () => setInspector(null),
    }),
    [],
  );

  return (
    <ToastProvider>
    <InspectorCtx.Provider value={inspectorApi}>
      <div data-shell-root className="flex h-dvh overflow-hidden bg-canvas text-ink">
        {/* data-app-shell — the background region made `inert` while a sheet
            is open below lg (useInertShell). Scoped to sidebar + header +
            content + bottom nav. Overlays must live OUTSIDE it so a sheet never
            inerts itself: CommandPalette, RightPushPanel and AssistantPanel
            are siblings below; the notification sheet, Apps sheet and
            shortcuts dialog (opened from inside the shell) render through
            ui/portal.tsx into document.body. */}
        <div data-app-shell className="flex min-w-0 flex-1">
          {/* skip link — first tab stop on every page (WCAG 2.4.1) */}
          <a
            href={`#${MAIN_CONTENT_ID}`}
            data-shell-chrome
            className="focus-ring sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-md"
          >
            Skip to content
          </a>
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
            {/* Solid surface, NOT a blurred one: a backdrop-filter makes the header the
                containing block for position:fixed descendants (it clipped the
                notification sheet 171px above the viewport) and DESIGN.md bans blur. */}
            <header data-shell-chrome className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas px-3 sm:px-4">
              {/* macOS window chrome — terminal motif */}
              <div className="hidden pr-1 sm:flex">
                <TrafficLights size="md" />
              </div>
              {/* brand shown when there's no sidebar (mobile/tablet) */}
              <div className="flex items-center gap-1.5 lg:hidden">
                <span className="inline-block h-4 w-[3px] animate-pulse motion-reduce:animate-none rounded-[1px] bg-accent" />
                <span className="font-mono font-semibold tracking-tight text-ink">nopm</span>
              </div>
              {/* collapse toggle — desktop only (display:none below lg, so the
                  44px tap area IconButton carries is for consistency only) */}
              <IconButton
                onClick={() => setCollapsed((v) => !v)}
                className="hidden lg:grid"
                label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
              >
                {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
              </IconButton>
              <div className="flex-1" />
              {/* live indicator */}
              <span className="mr-1 hidden items-center gap-1.5 font-mono text-xs text-ink-muted sm:flex">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                live
              </span>
              <IconButton
                ref={assistantTriggerRef}
                onClick={() => setAssistantOpen((v) => !v)}
                label="Open AI assistant"
                aria-pressed={assistantOpen}
                className={cn("relative", assistantOpen && "bg-sunken text-accent")}
              >
                <Sparkles size={18} />
              </IconButton>
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
            <PageHint seed={onboardingSeed} />

            {/* content — `bg-grouped` (white in light, canvas-black in dark; tokens in
                globals.css); pad bottom on mobile so the bottom nav never covers it.
                Skip-link target and the focus fallback when a closed overlay's
                opener is gone (see useReturnFocus). */}
            <main
              id={MAIN_CONTENT_ID}
              tabIndex={-1}
              data-shell-main
              className="min-h-0 flex-1 overflow-auto bg-grouped pb-20 focus:outline-none lg:pb-0"
            >
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
          {inspector && <Fragment key={inspector.seq}>{inspector.content}</Fragment>}
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
