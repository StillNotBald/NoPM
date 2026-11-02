"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, apiGet, type ApiError } from "@/lib/api-client";
import { validateFields } from "@/lib/forms/validate";
import { Field, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import type { RagStatus } from "@/lib/status";

// ── Data shape ────────────────────────────────────────────────────────────────
export interface Program {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  owner_id: string | null;
  rag_status: RagStatus;
}

/** Lightweight shape returned by GET /api/resources — mirrors task-form.tsx's picker. */
interface WorkspaceMember {
  id: string;
  name: string;
  role_title?: string | null;
}

// ── ProgramForm ───────────────────────────────────────────────────────────────
export function ProgramForm({
  mode,
  program,
}: {
  mode: "create" | "edit";
  program?: Program;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [code, setCode] = useState(program?.code ?? "");
  const [name, setName] = useState(program?.name ?? "");
  const [description, setDescription] = useState(program?.description ?? "");
  const [ownerId, setOwnerId] = useState(program?.owner_id ?? "");
  const [ragStatus, setRagStatus] = useState<RagStatus>(
    program?.rag_status ?? "not_started",
  );

  // ── owner picker — resource_members, same source as the task assignee picker ──
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  useEffect(() => {
    apiGet<WorkspaceMember[]>("/api/resources?limit=100")
      .then((list) => setMembers(list ?? []))
      .catch(() => {
        /* non-critical — picker just stays empty */
      });
  }, []);

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
      { key: "name", value: name.trim(), message: "Program name is required" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const payload = {
      code: code || null,
      name,
      description: description || null,
      owner_id: ownerId || null,
      rag_status: ragStatus,
    };

    try {
      if (mode === "create") {
        const p = await apiPost<Program>("/api/programs", payload);
        toast.success("Program created");
        inspector.close();
        router.refresh();
        void p;
      } else {
        await apiPatch(`/api/programs/${program!.id}`, payload);
        toast.success("Program updated");
        router.refresh();
        inspector.close();
      }
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save program");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Title — the only visually prominent field */}
      <TitleField
        label="Program name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Program name"
        required
        error={fieldErrors.name}
      />

      <FormSection title="Identity">
        <FormGrid>
          <Field label="Code" error={fieldErrors.code}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PGM-001"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Owner" error={fieldErrors.owner_id}>
            <SelectInput value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">— Unassigned —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.role_title ? ` (${m.role_title})` : ""}
                </option>
              ))}
            </SelectInput>
          </Field>
        </FormGrid>
      </FormSection>

      <FormSection
        title="Health"
        description="Set by the program owner. Shown beside the rollup from child projects, never replacing it."
      >
        <FormGrid>
          <Field label="RAG Status" error={fieldErrors.rag_status}>
            <SelectInput
              value={ragStatus}
              onChange={(e) => setRagStatus(e.target.value as RagStatus)}
            >
              <option value="not_started">Not Started</option>
              <option value="green">Green</option>
              <option value="amber">Amber</option>
              <option value="red">Red</option>
              <option value="complete">Complete</option>
            </SelectInput>
          </Field>
          <div />
        </FormGrid>
      </FormSection>

      <FormSection>
        <Field label="Description" error={fieldErrors.description}>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this program covers"
          />
        </Field>
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
          ) : mode === "create" ? (
            "Create Program"
          ) : (
            "Save Changes"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
