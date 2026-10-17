"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, type ApiError } from "@/lib/api-client";
import {
  FieldLabel,
  FieldError,
} from "@/components/forms/project-form";
import {
  FormSection,
  FormGrid,
  FormActions,
} from "@/components/forms/form-shell";
import { validateFields } from "@/lib/forms/validate";

// ── ResourceForm ───────────────────────────────────────────────────────────────
export function ResourceForm() {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [email, setEmail] = useState("");
  const [costRate, setCostRate] = useState("");
  const [capacityHours, setCapacityHours] = useState("");

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
      { key: "name", value: name, message: "Name is required" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const payload = {
      name: name.trim(),
      role_title: roleTitle.trim() || null,
      email: email.trim() || null,
      cost_rate: costRate.trim() === "" ? null : Number(costRate),
      capacity_hours_per_week:
        capacityHours.trim() === "" ? null : Number(capacityHours),
    };

    try {
      await apiPost("/api/resources", payload);
      toast.success("Team member added");
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to add member");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {topError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink">
          {topError}
        </div>
      )}

      {/* Identity */}
      <FormSection title="Identity">
        {/* Name — prominent title-style */}
        <div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            required
            className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
          />
          <FieldError message={fieldErrors.name} />
        </div>

        <FormGrid cols={2}>
          <div>
            <FieldLabel>Role / Title</FieldLabel>
            <Input
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="e.g. Senior Engineer"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.role_title} />
          </div>

          <div>
            <FieldLabel>Email</FieldLabel>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.email} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Capacity & cost */}
      <FormSection title="Capacity & Cost">
        <FormGrid cols={2}>
          <div>
            <FieldLabel>Cost Rate / hr</FieldLabel>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={costRate}
              onChange={(e) => setCostRate(e.target.value)}
              placeholder="e.g. 120.00"
              className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
            />
            <FieldError message={fieldErrors.cost_rate} />
          </div>

          <div>
            <FieldLabel>Capacity h / wk</FieldLabel>
            <Input
              type="number"
              min={0}
              max={168}
              step={0.5}
              value={capacityHours}
              onChange={(e) => setCapacityHours(e.target.value)}
              placeholder="e.g. 40"
              className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
            />
            <FieldError message={fieldErrors.capacity_hours_per_week} />
          </div>
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
          disabled={saving || !name.trim()}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : (
            "Add Member"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
