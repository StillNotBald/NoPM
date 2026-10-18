"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiPatch } from "@/lib/api-client";
import { normalizePullRefInput, parsePullRef } from "@/lib/integrations/github/refs";
import { errorText } from "./model";

/**
 * "Link PR" on a task (R-153): ties the task to a GitHub pull request so GitHub work events move its
 * status. Accepts `owner/repo#42` or the pull request URL and stores `github:owner/repo#42` in the
 * task's external_ref (source `github`). Only offered when the task carries no other system's reference.
 */

export function canLinkPullRequest(task: { external_ref?: string | null }): boolean {
  return !task.external_ref || parsePullRef(task.external_ref) !== null;
}

export function LinkPullRequest({
  task,
  onChanged,
}: {
  task: { id: string; external_ref?: string | null };
  onChanged: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const linked = task.external_ref && parsePullRef(task.external_ref) ? task.external_ref.replace(/^github:/, "") : null;

  const normalized = normalizePullRefInput(value);
  const invalid = value.trim() !== "" && normalized === null;

  async function save(next: { external_ref: string | null; source: string | null }, done: string) {
    setBusy(true);
    try {
      await apiPatch(`/api/tasks/${task.id}`, next);
      toast.success(done);
      setValue("");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not update the pull request link."));
    } finally {
      setBusy(false);
    }
  }

  if (linked) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="break-all font-mono text-xs text-ink-secondary">{linked}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => save({ external_ref: null, source: null }, "Pull request unlinked.")}>
          Unlink
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-2 sm:flex-row sm:items-start"
      onSubmit={(e) => {
        e.preventDefault();
        if (normalized) void save({ external_ref: normalized, source: "github" }, "Pull request linked.");
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          aria-label="Pull request to link"
          aria-invalid={invalid}
          placeholder="owner/repo#42 or a pull request URL"
          value={value}
          maxLength={300}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid && (
          <p role="alert" className="mt-1 text-xs text-danger-ink">
            Use owner/repo#42 or the pull request address.
          </p>
        )}
      </div>
      <Button type="submit" size="sm" variant="secondary" disabled={busy || !normalized}>
        Link PR
      </Button>
    </form>
  );
}
