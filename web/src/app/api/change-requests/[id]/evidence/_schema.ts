import { z } from "zod";
import { EVIDENCE_RESULTS, EVIDENCE_TYPES } from "@/lib/documents/evidence-labels";

/** Document types an evidence record can be filed as (same list as the documents API). */
export const EVIDENCE_DOC_TYPES = [
  "charter", "plan", "raid", "status_report", "change_request", "minutes", "spec", "other",
] as const;

/**
 * POST /api/change-requests/:id/evidence (R-171).
 * Exactly one of: `document_id` (link an existing document) or `title` (create a new evidence document).
 * The change request comes from the path, and a new document is filed under the request's project.
 */
export const attachEvidenceSchema = z
  .object({
    document_id: z.string().uuid("document_id must be a valid UUID").optional(),
    // New document fields (used only when document_id is absent).
    title: z.string().trim().min(1, "title is required").max(500).optional(),
    doc_type: z.enum(EVIDENCE_DOC_TYPES).optional(),
    folder: z.string().min(1).max(100).optional(),
    summary: z.string().max(10_000).optional().nullable(),
    body: z.string().max(100_000).optional().nullable(),
    external_url: z.string().url("external_url must be a valid URL").max(2000).optional().nullable(),
    // Evidence fields.
    evidence_type: z.enum(EVIDENCE_TYPES, { error: `evidence_type must be one of ${EVIDENCE_TYPES.join(", ")}` }),
    evidence_result: z.enum(EVIDENCE_RESULTS).optional().nullable(),
    tested_by: z.string().trim().min(1).max(200).optional().nullable(),
    tested_at: z.string().datetime({ offset: true, message: "tested_at must be an ISO date-time" }).optional().nullable(),
    evidence_note: z.string().max(5000).optional().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.document_id && v.title) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "send document_id to link an existing document, or title to create one, not both" });
    }
    if (!v.document_id && !v.title) {
      ctx.addIssue({ code: "custom", path: ["document_id"], message: "send document_id (link an existing document) or title (create a new one)" });
    }
    if (v.document_id) {
      for (const k of ["doc_type", "folder", "summary", "body", "external_url"] as const) {
        if (v[k] !== undefined) {
          ctx.addIssue({ code: "custom", path: [k], message: `${k} applies to a new document; it cannot be sent with document_id` });
        }
      }
    }
  });

export type AttachEvidenceInput = z.infer<typeof attachEvidenceSchema>;
