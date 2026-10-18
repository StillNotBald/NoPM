"use client";

import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, FolderKanban, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { apiGet } from "@/lib/api-client";
import { addRecentProject, getRecentProjects, type RecentProject } from "@/lib/nav/recent-projects";
import { useEscapeClose } from "@/lib/hooks/use-sheet";

type ApiProject = { id: string; name: string; code: string };

export function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  // A failed fetch is NOT "no projects": it gets its own message and a retry.
  const [loadError, setLoadError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Load recents from localStorage on mount (client only)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(getRecentProjects());
  }, []);

  // Fetch projects from API when the panel opens (and on Retry)
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setLoadError(false);
    apiGet<ApiProject[]>("/api/projects")
      .then((data) => setProjects(data ?? []))
      .catch(() => {
        setProjects([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
    // Focus the search input
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, reloadTick]);

  // Escape closes (top-most overlay only) and hands focus back to the trigger.
  useEscapeClose(open, () => {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Tabbing out of the trigger + panel closes it. A blur with no new target (a mouse
  // press on a non-focusing button in Safari / Firefox on macOS) must not: it would
  // close the panel before the click on a project row lands. The mousedown
  // listener above handles outside presses.
  function onBlur(e: FocusEvent<HTMLDivElement>) {
    const next = e.relatedTarget as Node | null;
    if (open && next && !panelRef.current?.contains(next)) {
      setOpen(false);
      setQuery("");
    }
  }

  function select(project: ApiProject) {
    addRecentProject({ id: project.id, name: project.name, code: project.code });
    setRecents(getRecentProjects());
    setOpen(false);
    setQuery("");
    router.push(`/projects/${project.id}`);
  }

  const filtered = query.trim()
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.code.toLowerCase().includes(query.toLowerCase()),
      )
    : projects;

  const recentIds = new Set(recents.map((r) => r.id));
  const recentFull = recents
    .map((r) => projects.find((p) => p.id === r.id) ?? ({ id: r.id, name: r.name, code: r.code } as ApiProject))
    .filter(Boolean) as ApiProject[];
  const allFiltered = query.trim() ? filtered : filtered.filter((p) => !recentIds.has(p.id));

  return (
    <div className="relative" ref={panelRef} onBlur={onBlur}>
      {/* Trigger */}
      {collapsed ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Switch project"
          aria-label="Switch project"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          className={cn(
            "focus-ring flex h-9 w-9 items-center justify-center rounded-md transition-colors",
            open ? "bg-canvas text-ink" : "text-ink-secondary hover:bg-canvas/60",
          )}
        >
          <FolderKanban size={17} strokeWidth={2} />
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          className={cn(
            "focus-ring flex w-full items-center gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-[13px] transition-colors",
            open
              ? "border-border-strong bg-canvas text-ink"
              : "bg-canvas/40 text-ink-secondary hover:bg-canvas/70",
          )}
        >
          <FolderKanban size={14} strokeWidth={2} className="shrink-0 text-ink-muted" />
          <span className="flex-1 truncate text-left">Switch project</span>
          <ChevronsUpDown size={13} strokeWidth={2} className="shrink-0 text-ink-muted" />
        </button>
      )}

      {/* Panel */}
      {open && (
        <div
          id={panelId}
          className={cn(
            "absolute z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-lg",
            collapsed ? "left-10 top-0" : "left-0 top-full",
          )}
        >
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 focus-within:border-accent">
            <Search size={13} strokeWidth={2} className="shrink-0 text-ink-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-muted focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <p role="status" className="px-3 py-4 text-center text-xs text-ink-muted">Loading…</p>
            )}

            {!loading && loadError && (
              <div role="alert" className="px-3 py-4 text-center text-xs text-ink-secondary">
                <p>Couldn&apos;t load projects.</p>
                <button
                  type="button"
                  onClick={() => setReloadTick((n) => n + 1)}
                  className="focus-ring mt-1 rounded-sm font-medium text-accent hover:underline"
                >
                  Try again
                </button>
              </div>
            )}

            {!loading && !query.trim() && recentFull.length > 0 && (
              <>
                <div className="px-3 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                  Recent
                </div>
                {recentFull.map((p) => (
                  <ProjectRow key={p.id} project={p} onSelect={select} />
                ))}
              </>
            )}

            {!loading && (
              <>
                {!query.trim() && recentFull.length > 0 && allFiltered.length > 0 && (
                  <div className="px-3 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wide text-ink-muted">
                    All Projects
                  </div>
                )}
                {(query.trim() ? filtered : allFiltered).map((p) => (
                  <ProjectRow key={p.id} project={p} onSelect={select} />
                ))}
                {!loadError && (query.trim() ? filtered : allFiltered).length === 0 && recentFull.length === 0 && !loading && (
                  <p className="px-3 py-4 text-center text-xs text-ink-muted">No projects found.</p>
                )}
                {query.trim() && filtered.length === 0 && (
                  <p className="px-3 py-4 text-center text-xs text-ink-muted">No matches for &ldquo;{query}&rdquo;.</p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectRow({
  project,
  onSelect,
}: {
  project: ApiProject;
  onSelect: (p: ApiProject) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(project)}
      className="focus-ring-inset flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-well"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent/10 font-mono text-2xs font-bold text-accent">
        {project.code.slice(0, 2).toUpperCase()}
      </span>
      <span className="flex-1 truncate text-ink">{project.name}</span>
      <span className="shrink-0 font-mono text-2xs text-ink-muted">{project.code}</span>
    </button>
  );
}
