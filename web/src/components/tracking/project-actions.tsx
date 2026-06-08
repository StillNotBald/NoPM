"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useInspector } from "@/components/layout/app-shell";
import { useModal } from "@/components/ui/modal";
import { apiPost, type ApiError } from "@/lib/api-client";
import { ProjectForm, type Project } from "@/components/forms/project-form";

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

// ── ProjectActions ────────────────────────────────────────────────────────────

export function ProjectActions({ project }: ProjectActionsProps) {
  const router = useRouter();
  const inspector = useInspector();
  const modal = useModal();
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

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
      </div>

      {/* Inline error — shown beneath the button row, no browser alert */}
      {lockError && (
        <p className="text-xs text-danger text-right max-w-xs">{lockError}</p>
      )}
    </div>
  );
}
