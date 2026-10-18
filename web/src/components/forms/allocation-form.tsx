"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiGet, apiPostWithWarnings, type ApiError } from "@/lib/api-client";
import { Field, FormError, SelectInput } from "@/components/forms/project-form";
import {
  FormSection,
  FormGrid,
  FormActions,
} from "@/components/forms/form-shell";
import { validateFields } from "@/lib/forms/validate";

// ── Types ──────────────────────────────────────────────────────────────────────
interface MemberOption {
  id: string;
  name: string;
  role_title: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
  code: string | null;
}

// ── AllocationForm ─────────────────────────────────────────────────────────────
export function AllocationForm({
  defaultMemberId,
  defaultProjectId,
}: {
  defaultMemberId?: string;
  defaultProjectId?: string;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  // Picker options
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);

  // Form fields
  const [memberId, setMemberId] = useState(defaultMemberId ?? "");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [allocationPct, setAllocationPct] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [hours, setHours] = useState("");

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Load members + projects in parallel on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // apiGet unwraps json.data — for list endpoints okList returns
        // { data: [...], total, page, limit }, so apiGet returns the array.
        const [membersData, projectsData] = await Promise.all([
          apiGet<MemberOption[]>("/api/resources?limit=100"),
          apiGet<ProjectOption[]>("/api/projects?limit=100"),
        ]);
        if (!cancelled) {
          setMembers(Array.isArray(membersData) ? membersData : []);
          setProjects(Array.isArray(projectsData) ? projectsData : []);
        }
      } catch {
        // Non-fatal — pickers show empty with a helpful placeholder
      } finally {
        if (!cancelled) setLoadingOptions(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  function applyApiError(err: ApiError) {
    setTopError(err.message ?? "An error occurred.");
    const map: Record<string, string> = {};
    for (const f of err.fields ?? []) map[f.field] = f.message;
    setFieldErrors(map);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setFieldErrors({});

    const clientResult = validateFields([
      { key: "member_id", value: memberId, message: "Please select a team member", kind: "uuid" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    // Convert date-only strings to ISO datetime as the API schema expects
    function toIso(d: string): string | null {
      if (!d) return null;
      return d.includes("T") ? d : `${d}T00:00:00.000Z`;
    }

    const payload = {
      member_id: memberId,
      project_id: projectId || null,
      // Blank = omit (the API takes 0-500 or nothing; null is a 422).
      ...(allocationPct.trim() === "" ? {} : { allocation_pct: Number(allocationPct) }),
      hours: hours.trim() === "" ? null : Number(hours),
      window_start: toIso(windowStart),
      window_end: toIso(windowEnd),
    };

    try {
      const { warnings } = await apiPostWithWarnings("/api/allocations", payload);
      toast.success("Allocation created");
      // Non-blocking: the allocation was saved, the server just flags a concern.
      for (const w of warnings) toast.info(w, { duration: 8000 });
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to create allocation");
      setSaving(false);
    }
  }

  const selectedMember = members.find((m) => m.id === memberId);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Member + project selection */}
      <FormSection title="Assignment">
        <Field label="Team Member" required error={fieldErrors.member_id}>
          <SelectInput
            value={memberId}
            onChange={(e) => setMemberId(e.target.value)}
            disabled={loadingOptions}
          >
            <option value="">
              {loadingOptions ? "Loading members…" : "— Select member —"}
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.role_title ? ` — ${m.role_title}` : ""}
              </option>
            ))}
          </SelectInput>
        </Field>

        {selectedMember && (
          <p className="text-xs text-ink-muted">
            {selectedMember.role_title ?? "No role set"}
          </p>
        )}

        <Field label="Project" error={fieldErrors.project_id}>
          <SelectInput
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={loadingOptions}
          >
            <option value="">
              {loadingOptions ? "Loading projects…" : "— No project —"}
            </option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code ? `[${p.code}] ` : ""}
                {p.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </FormSection>

      {/* Allocation details */}
      <FormSection title="Allocation">
        <FormGrid cols={2}>
          <Field label="Allocation %" error={fieldErrors.allocation_pct}>
            <Input
              type="number"
              min={0}
              max={500}
              step={5}
              value={allocationPct}
              onChange={(e) => setAllocationPct(e.target.value)}
              placeholder="e.g. 100"
              className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
            />
          </Field>

          <Field label="Hours" error={fieldErrors.hours}>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="e.g. 40"
              className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
            />
          </Field>
        </FormGrid>

        <FormGrid cols={2}>
          <Field label="Window Start" error={fieldErrors.window_start}>
            <Input
              type="date"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Window End" error={fieldErrors.window_end}>
            <Input
              type="date"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      <FormActions>
        <Button
          type="button"
          variant="ghost"
          onClick={inspector.close}
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : (
            "Allocate"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
