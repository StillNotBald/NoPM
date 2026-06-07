"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

interface ApprovalActionsProps {
  requestId: string;
}

export function ApprovalActions({ requestId }: ApprovalActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: "approve" | "reject") {
    setPending(action);
    setError(null);
    try {
      const res = await fetch(`/api/deletion-requests/${requestId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `Failed to ${action} request.`);
      } else {
        router.refresh();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="text-xs text-danger bg-danger/15 rounded-md px-3 py-2 border border-danger/20">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={pending !== null}
          onClick={() => handleAction("approve")}
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={pending !== null}
          onClick={() => handleAction("reject")}
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </Button>
      </div>
    </div>
  );
}
