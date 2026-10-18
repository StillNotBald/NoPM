"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fetchFailedDeliveries, retryFailedDelivery } from "./api";
import { useApiResource } from "./hooks";
import { errorText } from "./model";
import { Disclosure, LoadingRow } from "./shared";

const KIND_TEXT: Record<string, string> = {
  approval_card: "Approval card",
  decision_update: "Card update",
  digest: "Weekly digest",
  bot_reply: "Bot reply",
};

/**
 * Admin-only list of messages NoPM gave up on (Q-ACC-14) with a Retry button
 * on each. Shown inside the connector panel only when something failed, so a
 * healthy connection stays quiet.
 */
export function FailedDeliveries({ connectorId, onChanged }: { connectorId: string; onChanged: () => void }) {
  const toast = useToast();
  const fetcher = useCallback(() => fetchFailedDeliveries(connectorId), [connectorId]);
  const { state, reload } = useApiResource(fetcher);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function retry(id: string) {
    setBusyId(id);
    try {
      const status = await retryFailedDelivery(connectorId, id);
      if (status === "sent") toast.success("Sent.");
      else if (status === "superseded") toast.info("Not sent: the request was decided in the meantime.");
      else toast.info("Queued to try again.");
      reload();
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not retry this message."));
    } finally {
      setBusyId(null);
    }
  }

  if (state.status === "loading") return <LoadingRow label="Loading failed messages" />;
  if (state.status !== "ready" || state.data.length === 0) return null;

  return (
    <Disclosure summary={`Failed messages (${state.data.length})`}>
      <ul className="divide-y divide-border-subtle">
        {state.data.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-ink">
                {KIND_TEXT[d.kind] ?? "Message"}
                {d.approvalKind ? (
                  <span className="font-normal text-ink-secondary"> · {d.approvalKind.replace(/_/g, " ")}</span>
                ) : null}
              </p>
              <p className="break-words text-xs text-ink-muted">
                {d.attempts} attempts{d.lastError ? ` · ${d.lastError}` : ""}
              </p>
            </div>
            <Button variant="secondary" size="sm" disabled={busyId !== null} onClick={() => retry(d.id)}>
              {busyId === d.id ? "Retrying..." : "Retry"}
            </Button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
