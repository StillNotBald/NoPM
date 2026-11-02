"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Lock, Pencil, AlertTriangle, Trash2, History, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useInspector } from "@/components/layout/app-shell";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPost, apiDelete, type ApiError } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { useMyRole } from "@/lib/nav/use-my-role";
import {
  ProjectForm,
  FieldLabel,
  FieldError,
  TextareaInput,
  type Project,
} from "@/components/forms/project-form";

interface ProjectActionsProps {
  project: Project;
}

// ── Inline confirmation dialog rendered inside the modal ──────────────────────

export const DEFAULT_LOCK_REASON = "Baseline frozen";

function LockConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Q-GOV-9 / D14: the lock reason is a human reason, prefilled but editable.
  const [reason, setReason] = useState(DEFAULT_LOCK_REASON);

  async function handleConfirm() {
    setBusy(true);
    onConfirm(reason.trim() || DEFAULT_LOCK_REASON);
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-warning/15 p-2">
          <AlertTriangle size={18} className="text-warning-ink" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">Lock this project?</p>
          <p className="mt-1 text-sm text-ink-secondary">
            Locking freezes the baseline: no changes until it is unlocked. Recorded in the audit log.
          </p>
        </div>
      </div>

      <div>
        <FieldLabel>Lock reason</FieldLabel>
        <TextareaInput
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          disabled={busy}
          maxLength={1000}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Lock baseline
        </Button>
      </div>
    </div>
  );
}

// ── Unlock confirmation dialog — reason REQUIRED (R-83 governed unlock) ───────
//
// Unlocking a frozen baseline is the more consequential half of the lock/
// unlock pair — it reopens dates the lock froze — so, unlike lock's optional
// reason, the API now REQUIRES one (POST /api/projects/[id]/unlock,
// unlockProjectSchema). Mirrors RequestDeletionDialog's reason-collection
// shape.

/** Rebaselines an unlock will cancel (migration 0058: pending_approval and approved). */
export const CANCELLED_ON_UNLOCK = ["pending_approval", "approved"] as const;

export function rebaselinesCancelledByUnlock<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => (CANCELLED_ON_UNLOCK as readonly string[]).includes(r.status));
}

interface RebaselineLite {
  id: string;
  status: string;
  version?: number | null;
  reason?: string | null;
}

function UnlockConfirmDialog({
  projectId,
  onConfirm,
  onCancel,
}: {
  projectId: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [affected, setAffected] = useState<RebaselineLite[] | null>(null);
  const [affectedFailed, setAffectedFailed] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<RebaselineLite[]>(`/api/projects/${projectId}/rebaselines?limit=100`)
      .then((rows) => live && setAffected(rebaselinesCancelledByUnlock(rows ?? [])))
      .catch(() => live && setAffectedFailed(true));
    return () => {
      live = false;
    };
  }, [projectId]);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  function handleConfirm() {
    if (!reason.trim()) {
      setFieldError("A reason is required. It goes on the audit trail.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    onConfirm(reason.trim());
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-warning/15 p-2">
          <AlertTriangle size={18} className="text-warning-ink" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">Unlock this project?</p>
          <p className="mt-1 text-sm text-ink-secondary">
            Unlocking allows edits again. Recorded in the audit log.
          </p>
          {affected && affected.length > 0 && (
            <div role="note" className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-ink">
              <p className="font-semibold">
                Unlocking cancels {affected.length} pending/approved rebaseline{affected.length === 1 ? "" : "s"}:
              </p>
              <ul className="mt-1 list-disc pl-4">
                {affected.map((r) => (
                  <li key={r.id}>
                    {r.version ? `v${r.version} ` : ""}
                    {r.status === "approved" ? "approved" : "pending sign-off"}
                    {r.reason ? ` — ${r.reason}` : ""}
                  </li>
                ))}
              </ul>
              <p className="mt-1">Confirm below to unlock and cancel them.</p>
            </div>
          )}
          {affectedFailed && (
            <p className="mt-2 text-xs text-ink-muted">
              Could not check for open rebaselines. Unlocking cancels any pending or approved ones.
            </p>
          )}
        </div>
      </div>

      <div>
        <FieldLabel required>Reason</FieldLabel>
        <TextareaInput
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (fieldError) setFieldError(undefined);
          }}
          placeholder="Why is this project being unlocked?"
          rows={3}
          disabled={busy}
          aria-required="true"
        />
        <FieldError message={fieldError} />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="secondary" size="sm" onClick={handleConfirm} disabled={busy}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Unlock
        </Button>
      </div>
    </div>
  );
}

// ── Request-deletion confirmation dialog (four-eyes maker step) ───────────────
//
// DELETE /api/projects/[id] no longer deletes the project — it raises a
// deletion_requests row (target_type='project') a different person must
// approve (Decision 3, devops-wave1: maker-checker extends to PROJECTS
// ONLY). Mirrors the task-delete request UX shape (reason required, no
// destructive action happens immediately).

function RequestDeletionDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  function handleConfirm() {
    if (!reason.trim()) {
      setFieldError("A reason is required. It goes on the audit trail.");
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    onConfirm(reason.trim());
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-danger/15 p-2">
          <AlertTriangle size={18} className="text-danger-ink" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">Request deletion of this project?</p>
          <p className="mt-1 text-sm text-ink-secondary">
            This raises a deletion request. A{" "}
            <span className="font-medium text-ink">different person</span> must approve it
            (four-eyes) before anything is removed. Recorded on the audit trail either way.
          </p>
        </div>
      </div>

      <div>
        <FieldLabel required>Reason</FieldLabel>
        <TextareaInput
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (fieldError) setFieldError(undefined);
          }}
          placeholder="Why should this project be deleted?"
          rows={3}
          disabled={busy}
          aria-required="true"
        />
        <FieldError message={fieldError} />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" onClick={handleConfirm} disabled={busy}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Request deletion
        </Button>
      </div>
    </div>
  );
}

// ── ProjectActions ────────────────────────────────────────────────────────────

export function ProjectActions({ project }: ProjectActionsProps) {
  const router = useRouter();
  const inspector = useInspector();
  const modal = useModal();
  const toast = useToast();
  // Lock and unlock are manager/admin actions, done in person (tokens can never unlock).
  const role = useMyRole();
  const canLock = role === "admin" || role === "manager";
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [deleteRequesting, setDeleteRequesting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // F9 — History/Lock/Request-deletion collapse into a 44px overflow menu
  // below the `@lg` CONTAINER width (the project header is an `@container`),
  // not the viewport: the right-hand inspector narrows the content column
  // without changing the viewport, and the inline row used to be squeezed
  // over the project title when a task was open. So "Request deletion" no longer wraps onto its own line
  // beside three other actions; Edit stays the one always-inline action.
  // Same collapse pattern as PageHeader's secondaryActions (page-header.tsx)
  // reimplemented here since this page's rich title row (code/name/program/
  // RAG+lock badges) doesn't fit PageHeader's title-string shape.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function executeLock(reason: string) {
    setLocking(true);
    setLockError(null);
    try {
      const res = await apiPost<{ already_locked?: boolean } | null>(`/api/projects/${project.id}/lock`, { reason });
      if (res?.already_locked) toast.info("Already locked — nothing changed");
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setLockError(apiErr.message ?? "Failed to lock project");
    } finally {
      setLocking(false);
    }
  }

  async function executeUnlock(reason: string) {
    setLocking(true);
    setLockError(null);
    try {
      await apiPost(`/api/projects/${project.id}/unlock`, { reason });
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setLockError(apiErr.message ?? "Failed to unlock project");
    } finally {
      setLocking(false);
    }
  }

  function handleLockToggle() {
    setLockError(null);
    if (project.is_locked) {
      modal.open(
        <UnlockConfirmDialog
          projectId={project.id}
          onConfirm={(reason) => {
            modal.close();
            void executeUnlock(reason);
          }}
          onCancel={() => {
            modal.close();
          }}
        />,
        { title: "Unlock project", size: "sm" },
      );
      return;
    }
    modal.open(
      <LockConfirmDialog
        onConfirm={(reason) => {
          modal.close();
          void executeLock(reason);
        }}
        onCancel={() => {
          modal.close();
        }}
      />,
      { title: "Lock project", size: "sm" },
    );
  }

  async function executeDeleteRequest(reason: string) {
    setDeleteRequesting(true);
    setDeleteError(null);
    try {
      await apiDelete(`/api/projects/${project.id}`, { reason });
      toast.success(
        "Deletion requested. A different person must approve it (four-eyes).",
      );
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setDeleteError(apiErr.message ?? "Failed to request deletion");
    } finally {
      setDeleteRequesting(false);
    }
  }

  function handleDeleteRequest() {
    setDeleteError(null);
    modal.open(
      <RequestDeletionDialog
        onConfirm={(reason) => {
          modal.close();
          void executeDeleteRequest(reason);
        }}
        onCancel={() => {
          modal.close();
        }}
      />,
      { title: "Request project deletion", size: "sm" },
    );
  }

  // History — the project's own audit trail
  const historyLink = (
    <Link
      href={`/trust?target_type=project&target_id=${project.id}`}
      onClick={() => setMenuOpen(false)}
      className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-md px-3 text-sm text-ink-secondary hover:bg-well hover:text-ink @lg:inline-flex @lg:h-9 @lg:min-h-0"
    >
      <History size={14} />
      History
    </Link>
  );

  // Lock / Unlock
  const lockButton = (
    <Button
      variant={project.is_locked ? "ghost" : "secondary"}
      size="sm"
      onClick={() => {
        setMenuOpen(false);
        handleLockToggle();
      }}
      disabled={locking}
      className={cn(
        "min-h-[44px] w-full justify-start @lg:w-auto @lg:min-h-0 @lg:justify-center",
        project.is_locked ? "text-warning-ink hover:text-warning-ink/80" : "",
      )}
    >
      {locking ? (
        <Spinner size="sm" className="mr-1.5" />
      ) : (
        <Lock size={14} className="mr-1.5" />
      )}
      {project.is_locked ? "Unlock" : "Lock"}
    </Button>
  );

  // Request deletion — four-eyes maker step; does not delete immediately
  const deleteButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        setMenuOpen(false);
        handleDeleteRequest();
      }}
      disabled={deleteRequesting}
      className="min-h-[44px] w-full justify-start text-danger-ink hover:bg-danger/10 @lg:w-auto @lg:min-h-0 @lg:justify-center"
    >
      {deleteRequesting ? (
        <Spinner size="sm" className="mr-1.5" />
      ) : (
        <Trash2 size={14} className="mr-1.5" />
      )}
      Request deletion
    </Button>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Edit — the one action that always stays inline */}
        <Button
          variant="secondary"
          size="sm"
          className="min-h-[44px] sm:min-h-0"
          onClick={() =>
            inspector.open(
              <ProjectForm mode="edit" project={project} />,
              "Edit Project",
            )
          }
        >
          <Pencil size={14} className="mr-1.5" />
          Edit
        </Button>

        {/* @lg+: History/Lock/Request deletion render inline, as before */}
        <div className="hidden items-center gap-2 @lg:flex">
          {historyLink}
          {canLock && lockButton}
          {deleteButton}
        </div>

        {/* below @lg: collapsed into one 44px overflow menu (F9) */}
        <div className="relative @lg:hidden" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-well"
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setMenuOpen(false)}
                aria-hidden="true"
              />
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1.5 min-w-[200px] space-y-1 rounded-lg border border-border-subtle bg-surface p-1.5 shadow-md"
              >
                {historyLink}
                {canLock && lockButton}
                {deleteButton}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Inline errors — shown beneath the button row, no browser alert */}
      {lockError && (
        <p className="text-xs text-danger-ink text-right max-w-xs">{lockError}</p>
      )}
      {deleteError && (
        <p className="text-xs text-danger-ink text-right max-w-xs">{deleteError}</p>
      )}
    </div>
  );
}
