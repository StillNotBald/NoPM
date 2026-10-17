"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  FileText,
  GitPullRequest,
  Lightbulb,
  Layers,
  Repeat,
  FolderKanban,
  CheckSquare,
  AlertTriangle,
  CircleDot,
  Zap,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useInspector } from "@/components/layout/app-shell";
import { modKeyLabel, useIsMac } from "@/components/layout/use-is-mac";
import { IconButton } from "@/components/ui/icon-button";
import { ProjectForm } from "@/components/forms/project-form";
import { ALL_NAV_ITEMS, EXTRA_NAV_ITEMS } from "@/lib/nav/nav-config";
import { useDialog } from "@/lib/hooks/use-sheet";
import type { SearchResult } from "@/app/api/search/route";

// ── Command definitions ───────────────────────────────────────────────────────

type CommandItem = {
  id: string;
  icon: React.ReactNode;
  label: string;
  hint: string;
  action: () => void;
};

// ── Fuzzy/contains match ──────────────────────────────────────────────────────
function matches(label: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  // simple subsequence-style contains
  return l.includes(q);
}

// ── Record type icon ──────────────────────────────────────────────────────────
function RecordIcon({ type }: { type: SearchResult["type"] }) {
  const size = 16;
  switch (type) {
    case "project":      return <FolderKanban size={size} />;
    case "task":         return <CheckSquare size={size} />;
    case "program":      return <Layers size={size} />;
    case "sprint":       return <Repeat size={size} />;
    case "risk":         return <AlertTriangle size={size} />;
    case "issue":        return <CircleDot size={size} />;
    case "clash":        return <Zap size={size} />;
    case "document":     return <FileText size={size} />;
    case "change_request": return <GitPullRequest size={size} />;
    case "decision":     return <Lightbulb size={size} />;
  }
}

// ── Record type label ─────────────────────────────────────────────────────────
const RECORD_TYPE_LABEL: Record<SearchResult["type"], string> = {
  project: "Project",
  task: "Task",
  program: "Program",
  sprint: "Sprint",
  risk: "Risk",
  issue: "Issue",
  clash: "Clash",
  document: "Document",
  change_request: "Change Request",
  decision: "Decision",
};

// ── CommandPalette (internal panel) ──────────────────────────────────────────

/**
 * ARIA combobox + listbox: the search input keeps DOM focus and points at the
 * highlighted option with `aria-activedescendant`, so a screen reader announces
 * the row Enter will run. Options are `tabIndex={-1}`: Tab leaves the list
 * (Clear / Close are the only other stops), arrows move the highlight.
 */
function CommandPalettePanel({
  onClose,
  inputRef,
}: {
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const router = useRouter();
  const inspector = useInspector();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  // A failed search (401 / 429 / 5xx / offline) is NOT "no records match".
  const [searchError, setSearchError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Build commands inside the component so hooks are in scope
  const allCommands: CommandItem[] = [
    {
      id: "new-project",
      icon: <Plus size={16} />,
      label: "New Project",
      hint: "Create",
      action: () => {
        onClose();
        inspector.open(<ProjectForm mode="create" scaffold />, "New Project");
      },
    },
    // Navigation commands derive from the one nav list/label map, so the
    // palette can never drift from the sidebar (names, icons, reachability).
    ...[...EXTRA_NAV_ITEMS.slice(0, 1), ...ALL_NAV_ITEMS, ...EXTRA_NAV_ITEMS.slice(1)].map(
      ({ href, label, icon: Icon }): CommandItem => ({
        id: `nav-${href.slice(1)}`,
        icon: <Icon size={16} />,
        label,
        hint: "Go to",
        action: () => {
          onClose();
          router.push(href);
        },
      }),
    ),
  ];

  const filtered = allCommands.filter((c) => matches(c.label, query));
  const trimmed = query.trim();

  // Debounced record search — also resets active index on each query change
  useEffect(() => {
    // Clear previous debounce
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Abort previous in-flight request
    if (abortRef.current) abortRef.current.abort();

    // Reset selection whenever the query changes
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIdx(0);

    if (!query.trim()) {
      setRecords([]);
      setRecordsLoading(false);
      setSearchError(false);
      return;
    }

    setRecordsLoading(true);
    setSearchError(false);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`search failed (${res.status})`);
          return res.json();
        })
        .then((json: { data?: SearchResult[] }) => {
          setRecords(json.data ?? []);
          setRecordsLoading(false);
          setActiveIdx(0);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setRecords([]);
          setRecordsLoading(false);
          setSearchError(true);
        });
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, retryTick]);

  // Flat ordered list for keyboard navigation: records first when a query is
  // active, then the static nav/create commands. Records are only navigable
  // once they are SHOWN (stale results from the previous query stay hidden
  // while a new search is in flight).
  const visibleRecords = recordsLoading || searchError ? [] : records;
  const totalItems = visibleRecords.length + filtered.length;
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const activeId = totalItems > 0 ? optionId(Math.min(activeIdx, totalItems - 1)) : undefined;

  // Keep the highlighted row visible by scrolling ONLY the results container
  // (scrollIntoView also scrolls every ancestor, including the document).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const el = scroller.querySelector<HTMLElement>(`[data-flat-idx="${activeIdx}"]`);
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (activeIdx === 0) scroller.scrollTop = 0;
    else if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }, [activeIdx, visibleRecords.length]);

  function runItem(idx: number) {
    if (idx < visibleRecords.length) {
      const rec = visibleRecords[idx];
      if (rec) {
        onClose();
        router.push(rec.href);
      }
    } else {
      const cmd = filtered[idx - visibleRecords.length];
      cmd?.action();
    }
  }

  // Escape is handled by the dialog (useDialog → useEscapeClose), not here, so
  // one keypress closes exactly one layer.
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(totalItems, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(Math.min(activeIdx, Math.max(totalItems - 1, 0)));
    }
  }

  // Polite summary for screen readers (the visible rows are not a live region).
  const announcement = !trimmed
    ? ""
    : recordsLoading
      ? "Searching records"
      : searchError
        ? "Search unavailable"
        : `${totalItems} ${totalItems === 1 ? "result" : "results"}`;

  const optionClass = (active: boolean) =>
    cn(
      "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100",
      active ? "bg-accent/10 text-ink" : "text-ink hover:bg-sunken",
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Search input */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 focus-within:border-accent">
        <Search size={15} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={totalItems > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search commands and records"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search commands…"
          className="min-h-9 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="focus-ring -my-1 min-h-11 shrink-0 rounded-sm px-2 text-xs text-ink-muted hover:text-ink sm:min-h-0 sm:px-1"
          >
            Clear
          </button>
        )}
        {/* Close — only shown below sm, where the dialog is full-screen and the
            backdrop is fully covered (no "click outside" escape hatch there). */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close command palette"
          className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-secondary hover:bg-sunken sm:hidden"
        >
          <X size={18} />
        </button>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Results */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto py-1.5 sm:max-h-80 sm:flex-none">
        {/* Search status rows sit OUTSIDE the listbox (its children must be options/groups) */}
        {trimmed && recordsLoading && (
          <div className="flex items-center gap-2 px-4 py-2">
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border border-border-subtle border-t-accent"
            />
            <span className="text-xs text-ink-muted">Searching records…</span>
          </div>
        )}
        {trimmed && !recordsLoading && searchError && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-ink-secondary">
            <span>Search unavailable.</span>
            <button
              type="button"
              onClick={() => setRetryTick((n) => n + 1)}
              className="focus-ring rounded-sm font-medium text-accent hover:underline"
            >
              Retry
            </button>
          </div>
        )}
        {trimmed && !recordsLoading && !searchError && records.length === 0 && (
          <div className="px-4 py-2 text-xs text-ink-muted">
            No records match &ldquo;{query}&rdquo;
          </div>
        )}

        <div role="listbox" id={listboxId} aria-label="Results">
          {/* ── Records ─────────────────────────────────────────────────── */}
          {visibleRecords.length > 0 && (
            <div role="group" aria-label="Records">
              <div aria-hidden="true" className="px-4 pb-1 pt-2">
                <span className="text-2xs font-semibold uppercase tracking-widest text-ink-muted">
                  Records
                </span>
              </div>
              {visibleRecords.map((rec, idx) => (
                <button
                  key={`rec-${rec.type}-${rec.id}`}
                  type="button"
                  role="option"
                  id={optionId(idx)}
                  aria-selected={idx === activeIdx}
                  tabIndex={-1}
                  data-flat-idx={idx}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => runItem(idx)}
                  className={optionClass(idx === activeIdx)}
                >
                  <span
                    className={cn(
                      "shrink-0",
                      idx === activeIdx ? "text-accent" : "text-ink-secondary",
                    )}
                  >
                    <RecordIcon type={rec.type} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{rec.label}</span>
                    {rec.sublabel && (
                      <span className="block truncate font-mono text-[11px] text-ink-muted">
                        {rec.sublabel}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
                    {RECORD_TYPE_LABEL[rec.type]}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* ── Commands ────────────────────────────────────────────────── */}
          {filtered.length > 0 && (
            <div role="group" aria-label="Commands">
              {/* Section heading only when a query splits the list into two sections */}
              {trimmed && (
                <div aria-hidden="true" className="px-4 pb-1 pt-2">
                  <span className="text-2xs font-semibold uppercase tracking-widest text-ink-muted">
                    Commands
                  </span>
                </div>
              )}
              {filtered.map((cmd, cmdIdx) => {
                const flatIdx = visibleRecords.length + cmdIdx;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    role="option"
                    id={optionId(flatIdx)}
                    aria-selected={flatIdx === activeIdx}
                    tabIndex={-1}
                    data-flat-idx={flatIdx}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIdx(flatIdx)}
                    onClick={cmd.action}
                    className={optionClass(flatIdx === activeIdx)}
                  >
                    <span
                      className={cn(
                        "shrink-0",
                        flatIdx === activeIdx ? "text-accent" : "text-ink-secondary",
                      )}
                    >
                      {cmd.icon}
                    </span>
                    <span className="flex-1 text-sm font-medium">{cmd.label}</span>
                    <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
                      {cmd.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2">
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-2xs">↑↓</kbd>
          navigate
        </span>
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-2xs">↵</kbd>
          run
        </span>
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-2xs">Esc</kbd>
          close
        </span>
      </div>
    </div>
  );
}

// ── CommandPalette (the mounted singleton) ────────────────────────────────────

type CommandPaletteProps = {
  /** Controlled open state (passed from app-shell) */
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A modal dialog: Escape closes the top-most layer only, Tab stays inside,
  // focus goes to the search input on open and back to whatever opened it on
  // close (or to <main> if that control is gone). Below lg it also locks body
  // scroll and makes the shell inert; the palette is outside [data-app-shell].
  useDialog({
    open,
    onClose: close,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    sheet: true,
  });

  // Global Cmd/Ctrl-K listener — toggles the palette from anywhere in the app
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      data-shell-chrome
      className="fixed inset-0 z-[60] flex items-stretch justify-center sm:items-start sm:pt-[15vh]"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={close} />

      {/* Panel — full-screen sheet below sm (w-full h-full inset-0, safe-area
          padding); sm+ keeps today's centered dialog pixel-identical. */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          "relative z-10 flex h-full w-full flex-col overflow-hidden focus:outline-none",
          "rounded-none border-0 bg-surface shadow-lg",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          "sm:h-auto sm:max-w-lg sm:rounded-xl sm:border sm:border-border-subtle sm:pt-0 sm:pb-0",
        )}
      >
        <CommandPalettePanel onClose={close} inputRef={inputRef} />
      </div>
    </div>
  );
}

// ── CmdK trigger button (rendered in the header) ──────────────────────────────

export function CmdKTrigger({ onClick }: { onClick: () => void }) {
  const mod = modKeyLabel(useIsMac());
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open command palette (${mod}+K)`}
      className={cn(
        "focus-ring hidden items-center gap-2 rounded-md border border-border-subtle",
        "bg-sunken px-2.5 py-1.5 font-mono text-xs text-ink-muted transition-colors duration-150",
        "hover:border-border-strong hover:text-ink sm:flex",
      )}
    >
      <span aria-hidden="true" className="text-accent">❯</span>
      <span>run command</span>
      <span aria-hidden="true" className="ml-1 rounded border border-border-strong px-1 text-2xs text-ink-muted">
        {mod === "⌘" ? "⌘K" : "Ctrl K"}
      </span>
    </button>
  );
}

// ── CmdK trigger — compact icon-only variant for phones (below sm) ────────────
// The pill above (CmdKTrigger) is `hidden … sm:flex`, so cross-entity search is
// otherwise unreachable below sm. This is its exact complement: `sm:hidden`.

export function CmdKTriggerMobile({ onClick }: { onClick: () => void }) {
  return (
    <IconButton onClick={onClick} label="Search" className="sm:hidden">
      <Search size={18} />
    </IconButton>
  );
}
