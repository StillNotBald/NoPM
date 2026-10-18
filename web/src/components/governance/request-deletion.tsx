"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { FieldError, FieldLabel, TextareaInput } from "@/components/forms/project-form";
import { apiDelete, apiGet, type ApiError } from "@/lib/api-client";

/**
 * Deletion by request (audit gap G8). Risks, issues, expenses, documents and milestones are
 * no longer deleted by one person: DELETE /api/<entity>/:id raises a deletion request and a
 * different person approves it. This is the maker-step UI for all five.
 *
 *   - RequestDeletionDialog: the reason dialog (stacked buttons on a phone, a row from sm up).
 *   - useRequestDeletion: opens the dialog, calls the API, toasts, refreshes the page.
 *   - usePendingDeletionIds: which records already have a request waiting, so the control reads
 *     "Deletion requested" instead of offering a second request.
 */
export type DeletionEntity = "risk" | "issue" | "expense" | "document" | "milestone";

const PATH: Record<DeletionEntity, string> = {
  risk: "risks",
  issue: "issues",
  expense: "expenses",
  document: "documents",
  milestone: "milestones",
};

export function RequestDeletionDialog({
  entity,
  name,
  consequence,
  onConfirm,
  onCancel,
}: {
  entity: DeletionEntity;
  name?: string | null;
  /** One extra line for the approver-facing effect, e.g. "Its tasks stay but are unlinked." */
  consequence?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  function submit() {
    if (!reason.trim()) {
      setFieldError("A reason is required. It is recorded on the audit trail.");
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
          <AlertTriangle size={18} className="text-danger-ink" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium text-ink">
            Request deletion of {name ? <>the {entity} &ldquo;{name}&rdquo;</> : `this ${entity}`}?
          </p>
          <p className="mt-1 text-sm text-ink-secondary">
            Nothing is deleted yet. A <span className="font-medium text-ink">different person</span> must approve the
            request first, and it is recorded on the audit trail either way.
            {consequence ? ` ${consequence}` : ""}
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
          placeholder={`Why should this ${entity} be deleted?`}
          rows={3}
          disabled={busy}
          aria-required="true"
        />
        <FieldError message={fieldError} />
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-0" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" className="min-h-[44px] sm:min-h-0" onClick={submit} disabled={busy}>
          {busy ? <Spinner size="sm" className="mr-1.5" /> : <Trash2 size={13} className="mr-1.5" aria-hidden="true" />}
          Request deletion
        </Button>
      </div>
    </div>
  );
}

type PendingRow = { target_type: string; target_id: string };
let pendingLoad: { at: number; promise: Promise<PendingRow[]> } | null = null;

/** One shared read of the pending requests, so a table of rows asks the API once, not once per row. */
function loadPendingRows(): Promise<PendingRow[]> {
  const now = Date.now();
  if (pendingLoad && now - pendingLoad.at < 3000) return pendingLoad.promise;
  const promise = apiGet<PendingRow[]>("/api/deletion-requests?status=pending&limit=100").then((r) => (Array.isArray(r) ? r : []));
  pendingLoad = { at: now, promise };
  promise.catch(() => {
    pendingLoad = null;
  });
  return promise;
}

/** The ids of records of this type with a pending deletion request (fail-soft: empty on any error). */
export function usePendingDeletionIds(entity: DeletionEntity): {
  pending: ReadonlySet<string>;
  markRequested: (id: string) => void;
} {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await loadPendingRows();
        if (!live) return;
        setPending(new Set(res.filter((r) => r.target_type === entity).map((r) => r.target_id)));
      } catch {
        // The control still works without it: the API answers a duplicate request with a clear 422.
      }
    })();
    return () => {
      live = false;
    };
  }, [entity]);

  const markRequested = useCallback((id: string) => {
    pendingLoad = null;
    setPending((prev) => new Set(prev).add(id));
  }, []);
  return { pending, markRequested };
}

/**
 * Returns `request(id, name)`: opens the reason dialog, raises the request and says what happens next.
 * `onRequested` runs after a 202 (e.g. to close an inspector). Errors go to `onError`.
 */
export function useRequestDeletion(
  entity: DeletionEntity,
  opts: {
    consequence?: string;
    onRequested?: (id: string) => void;
    onError?: (message: string) => void;
  } = {},
) {
  const modal = useModal();
  const router = useRouter();
  const toast = useToast();
  const { consequence, onRequested, onError } = opts;

  return useCallback(
    (id: string, name?: string | null) => {
      modal.open(
        <RequestDeletionDialog
          entity={entity}
          name={name}
          consequence={consequence}
          onCancel={modal.close}
          onConfirm={(reason) => {
            modal.close();
            void (async () => {
              try {
                await apiDelete(`/api/${PATH[entity]}/${id}`, { reason });
                toast.success(`Deletion requested. A different person must approve it before the ${entity} is removed.`);
                onRequested?.(id);
                router.refresh();
              } catch (err) {
                onError?.((err as ApiError).message ?? "Could not request the deletion. Please try again.");
              }
            })();
          }}
        />,
        { title: `Request ${entity} deletion`, size: "sm" },
      );
    },
    [modal, router, toast, entity, consequence, onRequested, onError],
  );
}

/** The state shown in place of the control once a request is waiting. */
export function DeletionRequestedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="warning" size="sm" className={className}>
      Deletion requested
    </Badge>
  );
}

/**
 * One control for the detail panels and tables of risks, issues, expenses and documents (UAT-006, UAT-011):
 * a "Request deletion" button that opens the reason dialog, or the "Deletion requested" note once a request waits.
 * `variant="icon"` is the compact form for table rows. The pending state is read once per panel from the API.
 */
export function RequestDeletionControl({
  entity,
  id,
  name,
  consequence,
  variant = "button",
  className,
  requested = false,
}: {
  entity: DeletionEntity;
  id: string;
  name?: string | null;
  consequence?: string;
  variant?: "button" | "icon";
  className?: string;
  /** Known to be waiting already (e.g. the page just read it); otherwise the control asks the API. */
  requested?: boolean;
}) {
  const { pending, markRequested } = usePendingDeletionIds(entity);
  const [error, setError] = useState<string | null>(null);
  const request = useRequestDeletion(entity, { consequence, onRequested: markRequested, onError: setError });

  if (requested || pending.has(id)) {
    return <DeletionRequestedBadge className={variant === "icon" ? undefined : className} />;
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            request(id, name);
          }}
          className={className ?? "focus-ring inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-muted hover:bg-well hover:text-danger-ink sm:h-8 sm:w-8"}
          aria-label={`Request deletion of ${entity}${name ? ` ${name}` : ""}`}
          title="Request deletion (a different person approves it)"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={className ?? "h-11 px-3 text-xs text-danger-ink hover:bg-danger/10 sm:h-9"}
          onClick={() => {
            setError(null);
            request(id, name);
          }}
        >
          <Trash2 size={13} className="mr-1.5" aria-hidden="true" />
          Request deletion
        </Button>
      )}
      {error && (
        <span role="alert" className="text-xs text-danger-ink">
          {error}
        </span>
      )}
    </span>
  );
}
