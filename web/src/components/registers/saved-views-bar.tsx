"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, ChevronDown, Copy, Lock, LockOpen, Share2, Trash2, Users, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPost, apiPatch, apiDelete, type ApiError } from "@/lib/api-client";
import type { SavedViewConfig } from "@/lib/views/view-config";
import { cn } from "@/lib/cn";

export type SavedView = {
  id: string;
  register: string;
  name: string;
  config: Record<string, unknown>;
  scope: "personal" | "shared";
  protected: boolean;
  owner_id: string | null;
  updated_at: string;
};

/**
 * Save-view button + views dropdown (L-05/06/07/41) for one register page.
 * The caller owns the URL/column/groupBy state; this component only reads a
 * snapshot of it (`currentConfig`) to POST, and hands a loaded view's config
 * back via `onApply` for the caller to push into its own state — this
 * component never touches the URL itself, keeping it reusable across
 * registers with different state shapes (tasks today, risks/issues/clashes
 * later — same component, different `register` + `currentConfig`).
 */
export function SavedViewsBar({
  register,
  currentConfig,
  activeViewId,
  onApply,
}: {
  register: string;
  currentConfig: SavedViewConfig;
  activeViewId: string | null;
  onApply: (view: SavedView) => void;
}) {
  const toast = useToast();
  const [me, setMe] = useState<{ id: string; role: string | null } | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveScope, setSaveScope] = useState<"personal" | "shared">("personal");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<{ id: string; role: string | null }>("/api/me")
      .then(setMe)
      .catch(() => {
        /* non-critical — owner/admin controls just stay hidden */
      });
  }, []);

  function refresh() {
    setLoading(true);
    apiGet<SavedView[]>(`/api/saved-views?register=${encodeURIComponent(register)}&limit=100`)
      .then((list) => setViews(list ?? []))
      .catch(() => {
        /* dropdown just shows empty — non-fatal for the register itself */
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- house pattern (see theme-toggle/tasks page): kicks off the initial + register-change fetch, setLoading(true) is inside refresh() itself
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register]);

  // Close either popover on an outside click.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setSaveOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      const created = await apiPost<SavedView>("/api/saved-views", {
        register,
        name: saveName.trim(),
        scope: saveScope,
        config: currentConfig,
      });
      toast.success(`Saved view "${created.name}"`);
      setSaveOpen(false);
      setSaveName("");
      refresh();
      onApply(created);
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to save view");
    } finally {
      setSaving(false);
    }
  }

  async function toggleShare(view: SavedView) {
    try {
      const updated = await apiPatch<SavedView>(`/api/saved-views/${view.id}`, {
        scope: view.scope === "shared" ? "personal" : "shared",
      });
      toast.success(updated.scope === "shared" ? "View shared with the workspace" : "View made personal");
      refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to change sharing");
    }
  }

  async function toggleProtect(view: SavedView) {
    try {
      const updated = await apiPatch<SavedView>(`/api/saved-views/${view.id}`, {
        protected: !view.protected,
      });
      toast.success(updated.protected ? "View protected" : "View unprotected");
      refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to change protection");
    }
  }

  async function duplicate(view: SavedView) {
    try {
      const copy = await apiPost<SavedView>(`/api/saved-views/${view.id}/duplicate`, {});
      toast.success(`Duplicated as "${copy.name}"`);
      refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to duplicate view");
    }
  }

  async function remove(view: SavedView) {
    try {
      await apiDelete(`/api/saved-views/${view.id}`);
      toast.success(`Deleted "${view.name}"`);
      refresh();
    } catch (err) {
      toast.error((err as ApiError).message ?? "Failed to delete view");
    }
  }

  const personalViews = views.filter((v) => v.scope === "personal");
  const sharedViews = views.filter((v) => v.scope === "shared");

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="min-h-[44px] sm:min-h-0"
        onClick={() => {
          setDropdownOpen((o) => !o);
          setSaveOpen(false);
        }}
      >
        <Bookmark size={14} className="mr-1.5" />
        {activeView ? activeView.name : "Views"}
        <ChevronDown size={14} className="ml-1.5" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-[44px] sm:min-h-0"
        onClick={() => {
          setSaveOpen((o) => !o);
          setDropdownOpen(false);
          setSaveName(activeView ? `${activeView.name} (copy)` : "");
        }}
      >
        Save view
      </Button>

      {dropdownOpen && (
        <div className="absolute left-0 top-full z-20 mt-2 w-80 rounded-lg border border-border-subtle bg-surface p-2 shadow-lg">
          {loading && (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-ink-muted">
              <Spinner size="sm" /> Loading views…
            </div>
          )}
          {!loading && views.length === 0 && (
            <p className="px-2 py-3 text-sm text-ink-muted">No saved views for this register yet.</p>
          )}
          {!loading && personalViews.length > 0 && (
            <ViewSection
              label="Personal"
              icon={<User size={12} />}
              items={personalViews}
              activeViewId={activeViewId}
              me={me}
              onApply={(v) => {
                onApply(v);
                setDropdownOpen(false);
              }}
              onToggleShare={toggleShare}
              onToggleProtect={toggleProtect}
              onDuplicate={duplicate}
              onDelete={remove}
            />
          )}
          {!loading && sharedViews.length > 0 && (
            <ViewSection
              label="Shared"
              icon={<Users size={12} />}
              items={sharedViews}
              activeViewId={activeViewId}
              me={me}
              onApply={(v) => {
                onApply(v);
                setDropdownOpen(false);
              }}
              onToggleShare={toggleShare}
              onToggleProtect={toggleProtect}
              onDuplicate={duplicate}
              onDelete={remove}
            />
          )}
        </div>
      )}

      {saveOpen && (
        <form
          onSubmit={handleSave}
          className="absolute left-0 top-full z-20 mt-2 w-80 space-y-3 rounded-lg border border-border-subtle bg-surface p-3 shadow-lg"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Save current filters + sort + columns + grouping
          </p>
          <Input
            autoFocus
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="View name"
            className="h-10 text-sm"
          />
          <div className="flex items-center gap-3 text-sm">
            <label className="flex min-h-[44px] items-center gap-1.5 sm:min-h-0">
              <input
                type="radio"
                name="saved-view-scope"
                checked={saveScope === "personal"}
                onChange={() => setSaveScope("personal")}
              />
              Personal
            </label>
            <label className="flex min-h-[44px] items-center gap-1.5 sm:min-h-0">
              <input
                type="radio"
                name="saved-view-scope"
                checked={saveScope === "shared"}
                onChange={() => setSaveScope("shared")}
              />
              Shared
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving || !saveName.trim()}>
              {saving ? <Spinner size="sm" /> : "Save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ViewSection({
  label,
  icon,
  items,
  activeViewId,
  me,
  onApply,
  onToggleShare,
  onToggleProtect,
  onDuplicate,
  onDelete,
}: {
  label: string;
  icon: React.ReactNode;
  items: SavedView[];
  activeViewId: string | null;
  me: { id: string; role: string | null } | null;
  onApply: (v: SavedView) => void;
  onToggleShare: (v: SavedView) => void;
  onToggleProtect: (v: SavedView) => void;
  onDuplicate: (v: SavedView) => void;
  onDelete: (v: SavedView) => void;
}) {
  return (
    <div className="mb-1 last:mb-0">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        {icon}
        {label}
      </div>
      <ul>
        {items.map((view) => {
          const canManage = me != null && (me.id === view.owner_id || me.role === "admin");
          return (
            <li
              key={view.id}
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5",
                view.id === activeViewId ? "bg-accent/10" : "hover:bg-sunken",
              )}
            >
              <button
                type="button"
                onClick={() => onApply(view)}
                className="min-h-[44px] flex-1 text-left text-sm text-ink sm:min-h-0"
              >
                {view.name}
                {view.protected && <Lock size={11} className="ml-1.5 inline text-ink-muted" aria-label="Protected" />}
              </button>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                {/* Duplicate is available to ANYONE who can see the view —
                    protection guards the ORIGINAL's config, it never blocks
                    forking a personal working copy (L-07; the duplicate route
                    only requires visibility). Manage actions stay owner/admin. */}
                <IconAction label="Duplicate as personal copy" onClick={() => onDuplicate(view)}>
                  <Copy size={13} />
                </IconAction>
                {canManage && (
                  <>
                    <IconAction label={view.scope === "shared" ? "Make personal" : "Share with workspace"} onClick={() => onToggleShare(view)}>
                      <Share2 size={13} />
                    </IconAction>
                    <IconAction label={view.protected ? "Unprotect" : "Protect"} onClick={() => onToggleProtect(view)}>
                      {view.protected ? <LockOpen size={13} /> : <Lock size={13} />}
                    </IconAction>
                    <IconAction label="Delete" onClick={() => onDelete(view)}>
                      <Trash2 size={13} />
                    </IconAction>
                  </>
                )}
              </div>
              {!canManage && (
                <Badge tone="neutral" size="sm" className="shrink-0">
                  {view.scope}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-8 w-8 min-h-[44px] min-w-[44px] place-items-center rounded text-ink-secondary hover:bg-sunken hover:text-ink sm:h-7 sm:w-7 sm:min-h-0 sm:min-w-0"
    >
      {children}
    </button>
  );
}
