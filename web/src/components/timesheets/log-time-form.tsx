"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { Field, FormError, SelectInput } from "@/components/forms/project-form";
import { apiGet, apiPost, type ApiError } from "@/lib/api-client";
import { WEEK_LOCK_ERROR_CODES, WEEK_LOCK_REASON, lockForDate, type LockSubmission } from "./week-lock";

/**
 * Minimal log-time form (L-30) — the FIRST time-logging UI in the product
 * (recon-time.md §3: previously only the seed script wrote time_entries).
 * Deliberately small: member/project/task/date/hours/billable/note, one
 * POST to the existing /api/time-entries (no new write path). Member
 * defaults to the caller's own linked resource_member when known, but any
 * member can be chosen — the API itself has no self-only restriction
 * (recon-time.md §2 flags that as a timesheet-submission concern, not a
 * logging-form concern).
 *
 * A member's week is frozen by the API (422 period_locked / timesheet_locked)
 * while its timesheet is approved, or submitted and not reopened. The form
 * looks the chosen member's submissions up, says so in one line and disables
 * "Log time" for a date inside such a week; if a write is attempted anyway
 * (stale view, another tab) the API's own message is shown inline.
 */

interface NamedOption {
  id: string;
  name: string;
}

interface TaskOption {
  id: string;
  name: string;
  project_id: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function LogTimeForm({ defaultMemberId }: { defaultMemberId?: string }) {
  const router = useRouter();
  const toast = useToast();

  const [members, setMembers] = useState<NamedOption[]>([]);
  const [projects, setProjects] = useState<NamedOption[]>([]);
  const [tasks, setTasks] = useState<TaskOption[]>([]);

  const [memberId, setMemberId] = useState(defaultMemberId ?? "");
  const [projectId, setProjectId] = useState("");
  const [taskId, setTaskId] = useState("");
  const [entryDate, setEntryDate] = useState(todayIso());
  const [hours, setHours] = useState("");
  const [billable, setBillable] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // Submissions of the chosen member, keyed by member so a stale answer for a
  // previously chosen member is never applied to the current one.
  const [submissions, setSubmissions] = useState<{ memberId: string; rows: LockSubmission[] } | null>(null);
  const [lockRefresh, setLockRefresh] = useState(0);

  useEffect(() => {
    apiGet<NamedOption[]>("/api/resources?limit=100").then((list) => setMembers(list ?? [])).catch(() => {});
    apiGet<NamedOption[]>("/api/projects?limit=100").then((list) => setProjects(list ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    apiGet<LockSubmission[]>(`/api/timesheet-submissions?member_id=${memberId}&limit=100`)
      .then((list) => {
        if (!cancelled) setSubmissions({ memberId, rows: list ?? [] });
      })
      .catch(() => {
        /* non-critical — the API still refuses a frozen week and its message is shown */
      });
    return () => {
      cancelled = true;
    };
  }, [memberId, lockRefresh]);

  const lock =
    memberId && entryDate && submissions?.memberId === memberId ? lockForDate(entryDate, submissions.rows) : null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    apiGet<TaskOption[]>(`/api/tasks?project_id=${projectId}&limit=100`)
      .then((list) => {
        if (!cancelled) setTasks(list ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function handleProjectChange(value: string) {
    setProjectId(value);
    setTasks([]);
    setTaskId("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);
    if (!memberId || !projectId || !entryDate || !hours || lock) return;
    setBusy(true);
    try {
      await apiPost("/api/time-entries", {
        member_id: memberId,
        project_id: projectId,
        task_id: taskId || undefined,
        entry_date: entryDate,
        hours: Number(hours),
        billable,
        note: note || undefined,
      });
      toast.success("Time logged");
      setHours("");
      setNote("");
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.fields && apiErr.fields.length > 0) {
        setFieldErrors(Object.fromEntries(apiErr.fields.map((f) => [f.field, f.message])));
      }
      const message = apiErr.message ?? "Failed to log time";
      setFormError(message);
      toast.error(message);
      // The week was frozen after this form last looked: re-read so it disables itself.
      if (apiErr.code && WEEK_LOCK_ERROR_CODES.includes(apiErr.code)) setLockRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <FormError message={formError} />
      {lock && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-medium text-warning-ink"
        >
          <Lock size={13} aria-hidden className="shrink-0" />
          {WEEK_LOCK_REASON[lock]}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Member" required error={fieldErrors.member_id}>
          <SelectInput value={memberId} onChange={(e) => {
              setMemberId(e.target.value);
              setFormError(null);
            }} required>
            <option value="">— Select —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Project" required error={fieldErrors.project_id}>
          <SelectInput value={projectId} onChange={(e) => handleProjectChange(e.target.value)} required>
            <option value="">— Select —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Task (optional)" error={fieldErrors.task_id}>
          <SelectInput value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!projectId}>
            <option value="">— None —</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="Date" required error={fieldErrors.entry_date}>
          <Input type="date" value={entryDate} onChange={(e) => {
              setEntryDate(e.target.value);
              setFormError(null);
            }} required />
        </Field>
        <Field label="Hours" required error={fieldErrors.hours}>
          <Input
            type="number"
            inputMode="decimal"
            min="0.25"
            step="0.25"
            placeholder="e.g. 4"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            required
          />
        </Field>
        <label className="flex h-11 items-center gap-2 sm:h-10">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="focus-ring h-4 w-4 rounded border-border-subtle"
          />
          <span className="text-sm text-ink-secondary">Billable</span>
        </label>
        <Button type="submit" disabled={busy || lock !== null} className="h-11 sm:h-10">
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Log time
        </Button>
      </div>

      <Field label="Note (optional)" error={fieldErrors.note}>
        <Input placeholder="What did you work on?" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </form>
  );
}
