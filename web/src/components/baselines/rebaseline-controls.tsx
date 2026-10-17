"use client";

/**
 * Write controls for the governed rebaseline flow (D1 / Q-GOV-6), on /baselines:
 * propose (on a locked project), sign off go / no-go, and apply once approved.
 * Existing routes only:
 *   POST /api/projects/:id/rebaselines   { reason, before?, after? }
 *   POST /api/rebaselines/:id/signoff    { vote: "go" | "no_go", comment? }
 *   POST /api/rebaselines/:id/apply
 * Server refusals (403 role_not_permitted, 403/422 four-eyes, 409/422 state)
 * are shown verbatim: the API's message is the rule.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { FieldLabel, FieldError, TextareaInput } from "@/components/forms/project-form";
import { apiPost, type ApiError } from "@/lib/api-client";
import type { RebaselineActionState } from "./rebaseline-rules";

function errorText(err: unknown, fallback: string): string {
  const e = err as ApiError;
  return e?.message || fallback;
}

// ── Propose ───────────────────────────────────────────────────────────────────

function ProposeDialog({
  projectId,
  projectName,
  onDone,
  onCancel,
}: {
  projectId: string;
  projectName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) {
      setFieldError("A reason is required. Approvers sign what you write here.");
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/rebaselines`, {
        reason: reason.trim(),
        ...(before.trim() ? { before: before.trim() } : {}),
        ...(after.trim() ? { after: after.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(errorText(err, "Failed to propose the rebaseline."));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Propose a rebaseline for <span className="font-medium text-ink">{projectName}</span>. A different manager or
        admin must sign off before it can be applied. Recorded on the audit trail.
      </p>
      <div>
        <FieldLabel required>Reason</FieldLabel>
        <TextareaInput
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={busy}
          aria-required="true"
          placeholder="Why does the baseline need to move?"
        />
        <FieldError message={fieldError} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Current plan (optional)</FieldLabel>
          <TextareaInput
            value={before}
            onChange={(e) => setBefore(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder="e.g. Go-live 30 Nov"
          />
        </div>
        <div>
          <FieldLabel>Proposed plan (optional)</FieldLabel>
          <TextareaInput
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder="e.g. Go-live 14 Dec"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Propose rebaseline
        </Button>
      </div>
    </div>
  );
}

export function ProposeRebaselineButton({
  projectId,
  projectName,
  disabledReason,
}: {
  projectId: string;
  projectName: string;
  /** Set when proposing is pointless right now (e.g. one is already pending). */
  disabledReason?: string | null;
}) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      size="sm"
      className="h-11 sm:h-8"
      disabled={!!disabledReason}
      title={disabledReason ?? undefined}
      onClick={() =>
        modal.open(
          <ProposeDialog
            projectId={projectId}
            projectName={projectName}
            onCancel={() => modal.close()}
            onDone={() => {
              modal.close();
              toast.success("Rebaseline proposed. A different manager or admin must sign off.");
              router.refresh();
            }}
          />,
          { title: "Propose rebaseline", size: "md" },
        )
      }
    >
      Propose rebaseline
    </Button>
  );
}

// ── Sign off ──────────────────────────────────────────────────────────────────

function SignoffDialog({
  rebaselineId,
  projectName,
  onDone,
  onCancel,
}: {
  rebaselineId: string;
  projectName: string;
  onDone: (vote: "go" | "no_go") => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"go" | "no_go" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function vote(v: "go" | "no_go") {
    if (v === "no_go" && !comment.trim()) {
      setError("Say why when voting no-go.");
      return;
    }
    setError(null);
    setBusy(v);
    try {
      await apiPost(`/api/rebaselines/${rebaselineId}/signoff`, {
        vote: v,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      onDone(v);
    } catch (err) {
      setError(errorText(err, "Failed to record the sign-off."));
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-secondary">
        Sign off the rebaseline for <span className="font-medium text-ink">{projectName}</span>. One go approves it at
        once; one no-go rejects it for good.
      </p>
      <div>
        <FieldLabel>Comment</FieldLabel>
        <TextareaInput
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={2000}
          disabled={busy !== null}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" onClick={() => vote("no_go")} disabled={busy !== null}>
          {busy === "no_go" ? <Spinner size="sm" className="mr-1.5" /> : null}
          No-go
        </Button>
        <Button variant="primary" size="sm" onClick={() => vote("go")} disabled={busy !== null}>
          {busy === "go" ? <Spinner size="sm" className="mr-1.5" /> : null}
          Go
        </Button>
      </div>
    </div>
  );
}

// ── Row actions ───────────────────────────────────────────────────────────────

export function RebaselineRowActions({
  rebaselineId,
  projectName,
  state,
}: {
  rebaselineId: string;
  projectName: string;
  state: RebaselineActionState;
}) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  async function apply() {
    setApplying(true);
    setApplyError(null);
    try {
      await apiPost(`/api/rebaselines/${rebaselineId}/apply`);
      toast.success("Rebaseline applied. The project baseline has moved.");
      router.refresh();
    } catch (err) {
      setApplyError(errorText(err, "Failed to apply the rebaseline."));
    } finally {
      setApplying(false);
    }
  }

  if (state.note) return <span className="text-xs text-ink-muted">{state.note}</span>;

  return (
    <div className="flex flex-col items-start gap-1">
      {state.canSignoff && (
        <Button
          variant="primary"
          size="sm"
          className="h-11 sm:h-8"
          onClick={() =>
            modal.open(
              <SignoffDialog
                rebaselineId={rebaselineId}
                projectName={projectName}
                onCancel={() => modal.close()}
                onDone={(v) => {
                  modal.close();
                  toast.success(v === "go" ? "Signed off: go. Ready to apply." : "Signed off: no-go. Rebaseline rejected.");
                  router.refresh();
                }}
              />,
              { title: "Sign off rebaseline", size: "sm" },
            )
          }
        >
          Sign off
        </Button>
      )}
      {state.canApply && (
        <Button variant="primary" size="sm" className="h-11 sm:h-8" onClick={apply} disabled={applying}>
          {applying ? <Spinner size="sm" className="mr-1.5" /> : null}
          Apply
        </Button>
      )}
      {applyError && (
        <p role="alert" className="max-w-xs text-xs text-danger-ink">
          {applyError}
        </p>
      )}
    </div>
  );
}
