"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  AlertTriangle,
  CircleDot,
  Zap,
  Users,
  DollarSign,
  CheckSquare,
  ShieldCheck,
  KeyRound,
  Plus,
  Search,
  FileText,
  GitPullRequest,
  Lightbulb,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useInspector } from "@/components/layout/app-shell";
import { ProjectForm } from "@/components/forms/project-form";
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
  risk: "Risk",
  issue: "Issue",
  clash: "Clash",
  document: "Document",
  change_request: "Change Request",
  decision: "Decision",
};

// ── CommandPalette (internal panel) ──────────────────────────────────────────

function CommandPalettePanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inspector = useInspector();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [records, setRecords] = useState<SearchResult[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

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
    {
      id: "nav-dashboard",
      icon: <LayoutDashboard size={16} />,
      label: "Dashboard",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/dashboard");
      },
    },
    {
      id: "nav-projects",
      icon: <FolderKanban size={16} />,
      label: "Projects",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/projects");
      },
    },
    {
      id: "nav-risks",
      icon: <AlertTriangle size={16} />,
      label: "Risks",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/risks");
      },
    },
    {
      id: "nav-issues",
      icon: <CircleDot size={16} />,
      label: "Issues",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/issues");
      },
    },
    {
      id: "nav-clashes",
      icon: <Zap size={16} />,
      label: "Clashes",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/clashes");
      },
    },
    {
      id: "nav-resources",
      icon: <Users size={16} />,
      label: "Resources",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/resources");
      },
    },
    {
      id: "nav-budget",
      icon: <DollarSign size={16} />,
      label: "Budget",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/budget");
      },
    },
    {
      id: "nav-approvals",
      icon: <CheckSquare size={16} />,
      label: "Approvals",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/approvals");
      },
    },
    {
      id: "nav-trust",
      icon: <ShieldCheck size={16} />,
      label: "Trust Center",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/trust");
      },
    },
    {
      id: "nav-tokens",
      icon: <KeyRound size={16} />,
      label: "Tokens",
      hint: "Go to",
      action: () => {
        onClose();
        router.push("/tokens");
      },
    },
  ];

  const filtered = allCommands.filter((c) => matches(c.label, query));

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
      return;
    }

    setRecordsLoading(true);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
      })
        .then((res) => res.json())
        .then((json: { data?: SearchResult[] }) => {
          setRecords(json.data ?? []);
          setRecordsLoading(false);
          setActiveIdx(0);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setRecords([]);
          setRecordsLoading(false);
        });
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query]);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll active item into view — query flat-indexed items via data-flat-idx
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-flat-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Flat ordered list for keyboard navigation: records section first when query
  // is active, then static nav/create commands.
  const totalItems = records.length + filtered.length;

  function runItem(idx: number) {
    if (idx < records.length) {
      const rec = records[idx];
      if (rec) {
        onClose();
        router.push(rec.href);
      }
    } else {
      const cmd = filtered[idx - records.length];
      cmd?.action();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(totalItems, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + Math.max(totalItems, 1)) % Math.max(totalItems, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(activeIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Search input */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <Search size={15} className="shrink-0 text-ink-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search commands…"
          className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="shrink-0 text-xs text-ink-muted hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      {/* Results list */}
      <ul ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
        {/* ── Records section ───────────────────────────────────────────── */}
        {query.trim() && (
          <>
            {recordsLoading && (
              <li className="flex items-center gap-2 px-4 py-2">
                <span className="h-3 w-3 animate-spin rounded-full border border-border-subtle border-t-accent" />
                <span className="text-xs text-ink-muted">Searching records…</span>
              </li>
            )}
            {!recordsLoading && records.length > 0 && (
              <>
                <li className="px-4 pb-1 pt-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">
                    Records
                  </span>
                </li>
                {records.map((rec, idx) => (
                  <li key={`rec-${rec.type}-${rec.id}`}>
                    <button
                      data-flat-idx={idx}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => runItem(idx)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100",
                        idx === activeIdx
                          ? "bg-accent/10 text-ink"
                          : "text-ink hover:bg-sunken",
                      )}
                    >
                      <span
                        className={cn(
                          "shrink-0",
                          idx === activeIdx ? "text-accent" : "text-ink-secondary",
                        )}
                      >
                        <RecordIcon type={rec.type} />
                      </span>
                      <span className="flex-1 min-w-0">
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
                  </li>
                ))}
              </>
            )}
            {!recordsLoading && records.length === 0 && (
              <li className="px-4 py-2 text-xs text-ink-muted">
                No records match &ldquo;{query}&rdquo;
              </li>
            )}
            {/* Divider between records and commands when both sections are visible */}
            {filtered.length > 0 && (
              <li className="px-4 pb-1 pt-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">
                  Commands
                </span>
              </li>
            )}
          </>
        )}

        {/* ── Commands section ──────────────────────────────────────────── */}
        {filtered.length === 0 && !query.trim() ? (
          <li className="px-4 py-6 text-center text-sm text-ink-muted">
            No results for &ldquo;{query}&rdquo;
          </li>
        ) : (
          filtered.map((cmd, cmdIdx) => {
            const flatIdx = records.length + cmdIdx;
            return (
              <li key={cmd.id}>
                <button
                  data-flat-idx={flatIdx}
                  onMouseEnter={() => setActiveIdx(flatIdx)}
                  onClick={cmd.action}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100",
                    flatIdx === activeIdx
                      ? "bg-accent/10 text-ink"
                      : "text-ink hover:bg-sunken",
                  )}
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
              </li>
            );
          })
        )}
      </ul>

      {/* Footer hint */}
      <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2">
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px]">↑↓</kbd>
          navigate
        </span>
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px]">↵</kbd>
          run
        </span>
        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
          <kbd className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px]">Esc</kbd>
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

  // Global Cmd/Ctrl-K listener — toggles the palette from anywhere in the app
  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
      // Esc closes when open; let the panel's own handler handle it too
      if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={close}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          "relative z-10 w-full max-w-lg overflow-hidden",
          "rounded-xl border border-border-subtle bg-surface shadow-lg",
          "animate-in fade-in slide-in-from-top-2 duration-200",
        )}
      >
        <CommandPalettePanel onClose={close} />
      </div>
    </div>
  );
}

// ── CmdK trigger button (rendered in the header) ──────────────────────────────

export function CmdKTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open command palette (⌘K)"
      className={cn(
        "hidden items-center gap-2 rounded-md border border-border-subtle",
        "bg-sunken px-2.5 py-1.5 font-mono text-xs text-ink-muted transition-colors duration-150",
        "hover:border-border-strong hover:text-ink sm:flex",
      )}
    >
      <span className="text-accent">❯</span>
      <span>run command</span>
      <span className="ml-1 rounded border border-border-strong px-1 text-[10px] text-ink-muted">⌘K</span>
    </button>
  );
}
