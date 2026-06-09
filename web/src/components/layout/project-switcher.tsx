"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, FolderKanban, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { apiGet } from "@/lib/api-client";
import { addRecentProject, getRecentProjects, type RecentProject } from "@/lib/nav/recent-projects";

type ApiProject = { id: string; name: string; code: string };

export function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load recents from localStorage on mount (client only)
  useEffect(() => {
    setRecents(getRecentProjects());
  }, []);

  // Fetch projects from API when the panel opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiGet<ApiProject[]>("/api/projects")
      .then((data) => setProjects(data ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoading(false));
    // Focus the search input
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

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
    <div className="relative" ref={panelRef}>
      {/* Trigger */}
      {collapsed ? (
        <button
          onClick={() => setOpen((v) => !v)}
          title="Switch project"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
            open ? "bg-canvas text-ink" : "text-ink-secondary hover:bg-canvas/60",
          )}
        >
          <FolderKanban size={17} strokeWidth={2} />
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-border-subtle px-2.5 py-1.5 text-[13px] transition-colors",
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
          className={cn(
            "absolute z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-lg",
            collapsed ? "left-10 top-0" : "left-0 top-full",
          )}
        >
          {/* Search */}
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <Search size={13} strokeWidth={2} className="shrink-0 text-ink-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-muted focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <p className="px-3 py-4 text-center text-xs text-ink-muted">Loading…</p>
            )}

            {!loading && !query.trim() && recentFull.length > 0 && (
              <>
                <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
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
                  <div className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                    All Projects
                  </div>
                )}
                {(query.trim() ? filtered : allFiltered).map((p) => (
                  <ProjectRow key={p.id} project={p} onSelect={select} />
                ))}
                {(query.trim() ? filtered : allFiltered).length === 0 && recentFull.length === 0 && !loading && (
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
      onClick={() => onSelect(project)}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-sunken"
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent/10 font-mono text-[10px] font-bold text-accent">
        {project.code.slice(0, 2).toUpperCase()}
      </span>
      <span className="flex-1 truncate text-ink">{project.name}</span>
      <span className="shrink-0 font-mono text-[10px] text-ink-muted">{project.code}</span>
    </button>
  );
}
