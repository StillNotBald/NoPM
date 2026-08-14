"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useInspector } from "@/components/layout/app-shell";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiDelete, type ApiError } from "@/lib/api-client";
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

function LockConfirmDialog({
  isLocked,
  onConfirm,
  onCancel,
}: {
  isLocked: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    onConfirm();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-warning/15 p-2">
          <AlertTriangle size={18} className="text-warning" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">
            {isLocked ? "Unlock this project?" : "Lock this project?"}
          </p>
          <p className="mt-1 text-sm text-ink-secondary">
            {isLocked
              ? "Unlocking will allow edits and mutations again. The action is recorded in the audit log."
              : "Locking freezes the baseline — no further mutations until unlocked. This is recorded in the audit log."}
          </p>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={isLocked ? "secondary" : "primary"}
          size="sm"
          onClick={handleConfirm}
          disabled={busy}
          className={!isLocked ? "bg-warning text-white hover:bg-warning/90 border-warning" : ""}
        >
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          {isLocked ? "Unlock" : "Lock baseline"}
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
      setFieldError("A reason is required — it is recorded on the audit trail.");
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
          <AlertTriangle size={18} className="text-danger" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">Request deletion of this project?</p>
          <p className="mt-1 text-sm text-ink-secondary">
            This does not delete the project immediately. It raises a deletion request that a{" "}
            <span className="font-medium text-ink">different person</span> must approve
            (four-eyes) before anything is removed — enforced at the API layer, and recorded on
            the audit trail either way.
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
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [deleteRequesting, setDeleteRequesting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function executeLockToggle() {
    setLocking(true);
    setLockError(null);
    try {
      if (project.is_locked) {
        await apiPost(`/api/projects/${project.id}/unlock`);
      } else {
        await apiPost(`/api/projects/${project.id}/lock`, {
          reason: "Baseline frozen",
        });
      }
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setLockError(apiErr.message ?? "Failed to toggle lock");
    } finally {
      setLocking(false);
    }
  }

  function handleLockToggle() {
    setLockError(null);
    modal.open(
      <LockConfirmDialog
        isLocked={project.is_locked}
        onConfirm={() => {
          modal.close();
          void executeLockToggle();
        }}
        onCancel={() => {
          modal.close();
        }}
      />,
      { title: project.is_locked ? "Unlock project" : "Lock project", size: "sm" },
    );
  }

  async function executeDeleteRequest(reason: string) {
    setDeleteRequesting(true);
    setDeleteError(null);
    try {
      await apiDelete(`/api/projects/${project.id}`, { reason });
      toast.success(
        "Deletion requested — a different person must approve it (four-eyes) before the project is removed.",
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

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Edit */}
        <Button
          variant="secondary"
          size="sm"
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

        {/* Lock / Unlock */}
        <Button
          variant={project.is_locked ? "ghost" : "secondary"}
          size="sm"
          onClick={handleLockToggle}
          disabled={locking}
          className={project.is_locked ? "text-warning hover:text-warning/80" : ""}
        >
          {locking ? (
            <Spinner size="sm" className="mr-1.5" />
          ) : (
            <Lock size={14} className="mr-1.5" />
          )}
          {project.is_locked ? "Unlock" : "Lock"}
        </Button>

        {/* Request deletion — four-eyes maker step; does not delete immediately */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDeleteRequest}
          disabled={deleteRequesting}
          className="text-danger hover:bg-danger/10"
        >
          {deleteRequesting ? (
            <Spinner size="sm" className="mr-1.5" />
          ) : (
            <Trash2 size={14} className="mr-1.5" />
          )}
          Request deletion
        </Button>
      </div>

      {/* Inline errors — shown beneath the button row, no browser alert */}
      {lockError && (
        <p className="text-xs text-danger text-right max-w-xs">{lockError}</p>
      )}
      {deleteError && (
        <p className="text-xs text-danger text-right max-w-xs">{deleteError}</p>
      )}
    </div>
  );
}
