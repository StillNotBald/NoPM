"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { SelectInput, FieldLabel, FieldError } from "@/components/forms/project-form";
import { apiGet, apiPost, type ApiError } from "@/lib/api-client";

/**
 * Minimal log-time form (L-30) — the FIRST time-logging UI in the product
 * (recon-time.md §3: previously only the seed script wrote time_entries).
 * Deliberately small: member/project/task/date/hours/billable/note, one
 * POST to the existing /api/time-entries (no new write path). Member
 * defaults to the caller's own linked resource_member when known, but any
 * member can be chosen — the API itself has no self-only restriction
 * (recon-time.md §2 flags that as a timesheet-submission concern, not a
 * logging-form concern).
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

  useEffect(() => {
    apiGet<NamedOption[]>("/api/resources?limit=100").then((list) => setMembers(list ?? [])).catch(() => {});
    apiGet<NamedOption[]>("/api/projects?limit=100").then((list) => setProjects(list ?? [])).catch(() => {});
  }, []);

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
    if (!memberId || !projectId || !entryDate || !hours) return;
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
      toast.error(apiErr.message ?? "Failed to log time");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <FieldLabel required>Member</FieldLabel>
          <SelectInput value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
            <option value="">— Select —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <FieldLabel required>Project</FieldLabel>
          <SelectInput value={projectId} onChange={(e) => handleProjectChange(e.target.value)} required>
            <option value="">— Select —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectInput>
        </div>
        <div>
          <FieldLabel>Task (optional)</FieldLabel>
          <SelectInput value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!projectId}>
            <option value="">— None —</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </SelectInput>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-end">
        <div>
          <FieldLabel required>Date</FieldLabel>
          <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />
        </div>
        <div>
          <FieldLabel required>Hours</FieldLabel>
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
          <FieldError message={fieldErrors.hours} />
        </div>
        <label className="flex h-11 items-center gap-2 sm:h-10">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="h-4 w-4 rounded border-border-subtle"
          />
          <span className="text-sm text-ink-secondary">Billable</span>
        </label>
        <Button type="submit" disabled={busy || !memberId || !projectId || !hours} className="h-11 sm:h-10">
          {busy ? <Spinner size="sm" className="mr-1.5" /> : null}
          Log time
        </Button>
      </div>

      <div>
        <FieldLabel>Note (optional)</FieldLabel>
        <Input placeholder="What did you work on?" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </form>
  );
}
