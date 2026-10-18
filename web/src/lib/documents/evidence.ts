import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldsError } from "@/lib/api/errors";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export { EVIDENCE_RESULTS, EVIDENCE_TYPES } from "@/lib/documents/evidence-labels";

export type EvidenceFields = {
  change_request_id?: string | null;
  evidence_type?: string | null;
  evidence_result?: string | null;
  tested_by_label?: string | null;
  tested_at?: string | null;
  evidence_note?: string | null;
};

const EVIDENCE_KEYS = ["evidence_type", "evidence_result", "tested_by_label", "tested_at", "evidence_note"] as const;

type DocState = EvidenceFields & { project_id?: string | null };

/**
 * Validate the evidence link of a document create or update.
 * `existing` is the stored row (null on create); `input` is the request.
 * Throws a 422 FieldsError when:
 *  - the change request is not in this workspace,
 *  - the change request belongs to a different project than the document,
 *  - an evidence field is sent without a change request,
 *  - a result is sent without a type.
 */
export async function assertEvidenceLink(
  db: SupabaseClient,
  workspaceId: string,
  existing: DocState | null,
  input: DocState,
): Promise<void> {
  const pick = <K extends keyof DocState>(k: K): DocState[K] | null =>
    (input[k] !== undefined ? input[k] : existing?.[k]) ?? null;

  const crId = pick("change_request_id") as string | null;
  const projectId = pick("project_id") as string | null;
  const failures: { field: string; message: string }[] = [];

  if (!crId) {
    for (const k of EVIDENCE_KEYS) {
      if (input[k] !== undefined && input[k] !== null) {
        failures.push({ field: k, message: `${k} needs a linked change request (change_request_id)` });
      }
    }
    if (failures.length) throw new FieldsError("Evidence fields need a change request", failures, "evidence_needs_change_request");
    return;
  }

  if (pick("evidence_result") && !pick("evidence_type")) {
    failures.push({ field: "evidence_result", message: "evidence_result needs an evidence_type" });
  }

  const linkChanged = input.change_request_id !== undefined || input.project_id !== undefined;
  if (linkChanged) {
    await assertRefsInWorkspace(db, workspaceId, [{ table: "change_requests", id: crId, field: "change_request_id" }]);
    const { data, error } = await db
      .from("change_requests")
      .select("project_id")
      .eq("id", crId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const crProject = (data as { project_id: string | null } | null)?.project_id ?? null;
    if ((crProject ?? null) !== (projectId ?? null)) {
      failures.push({
        field: "change_request_id",
        message: "The change request belongs to a different project than this document",
      });
    }
  }

  if (failures.length) throw new FieldsError("Evidence link rejected", failures, "evidence_link_invalid");
}

/** Updates to apply so an unlinked document carries no stale evidence fields. */
export function clearedEvidence(existing: EvidenceFields): Record<string, null> {
  const out: Record<string, null> = {};
  for (const k of EVIDENCE_KEYS) if (existing[k] != null) out[k] = null;
  return out;
}
