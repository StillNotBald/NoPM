"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { useModal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

/** Message for a failed action: the error's own message, plus API field errors when present. */
export function describeError(e: unknown, fallback: string): string {
  const base = e instanceof Error && e.message ? e.message : fallback;
  const fields =
    typeof e === "object" && e !== null && Array.isArray((e as { fields?: unknown }).fields)
      ? ((e as { fields: unknown[] }).fields as unknown[])
      : [];
  const details = fields
    .filter(
      (f): f is { field: string; message: string } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { field?: unknown }).field === "string" &&
        typeof (f as { message?: unknown }).message === "string",
    )
    .map((f) => `${f.field}: ${f.message}`);
  return details.length > 0 ? `${base} (${details.join("; ")})` : base;
}

/**
 * Body for `useModal().open(...)`: a confirm that keeps the dialog open and
 * shows the API's message inline if the action fails, and closes itself only
 * on success.
 *
 *   modal.open(
 *     <ConfirmDialog heading="Revoke “Team feed”?" confirmLabel="Revoke"
 *       failureFallback="Could not revoke the feed." onConfirm={() => revoke(id)}>
 *       <p>Anyone using the link loses access.</p>
 *     </ConfirmDialog>,
 *     { title: "Revoke feed", size: "sm" },
 *   );
 */
export function ConfirmDialog({
  heading,
  children,
  confirmLabel,
  failureFallback,
  onConfirm,
  tone = "danger",
}: {
  heading: string;
  children?: ReactNode;
  confirmLabel: string;
  failureFallback: string;
  onConfirm: () => Promise<void>;
  /** `danger` (default) for destructive actions; `default` for a plain confirm. */
  tone?: "danger" | "default";
}) {
  const modal = useModal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      modal.close();
    } catch (e) {
      setError(describeError(e, failureFallback));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className={cn("mt-0.5 shrink-0 rounded-full p-2", tone === "danger" ? "bg-danger/15" : "bg-accent/15")}>
          <AlertTriangle
            size={18}
            className={tone === "danger" ? "text-danger-ink" : "text-ink-secondary"}
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-ink">{heading}</p>
          {children && <div className="space-y-2 text-sm text-ink-secondary">{children}</div>}
        </div>
      </div>
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" onClick={modal.close} disabled={busy}>
          Cancel
        </Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} size="sm" onClick={confirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
