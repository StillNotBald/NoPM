import { z } from "zod";
import { EVIDENCE_RESULTS, EVIDENCE_TYPES } from "@/lib/documents/evidence-labels";

/**
 * Valid document types in NoPM.
 */
const docTypeEnum = z.enum([
  "charter",
  "plan",
  "raid",
  "status_report",
  "change_request",
  "minutes",
  "spec",
  "other",
]);

/**
 * Valid document statuses.
 */
const docStatusEnum = z.enum(["draft", "in_review", "approved", "archived"]);

export const createDocumentSchema = z.object({
  project_id:   z.string().uuid("project_id must be a valid UUID").optional().nullable(),
  folder:       z.string().min(1).max(100).optional().default("General"),
  title:        z.string().min(1, "title is required").max(500),
  doc_type:     docTypeEnum,
  status:       docStatusEnum.optional().default("draft"),
  summary:      z.string().max(10_000).optional().nullable(),
  body:         z.string().max(100_000).optional().nullable(),
  external_url: z.string().url("external_url must be a valid URL").max(2000).optional().nullable(),
  owner_id:     z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  change_request_id: z.string().uuid("change_request_id must be a valid UUID").optional().nullable(),
  evidence_type:     z.enum(EVIDENCE_TYPES).optional().nullable(),
  evidence_result:   z.enum(EVIDENCE_RESULTS).optional().nullable(),
  tested_by_label:   z.string().trim().min(1).max(200).optional().nullable(),
  tested_at:         z.string().datetime({ offset: true, message: "tested_at must be an ISO date-time" }).optional().nullable(),
  evidence_note:     z.string().max(5000).optional().nullable(),
});

export const updateDocumentSchema = z.object({
  project_id:   z.string().uuid("project_id must be a valid UUID").optional().nullable(),
  folder:       z.string().min(1).max(100).optional(),
  title:        z.string().min(1).max(500).optional(),
  doc_type:     docTypeEnum.optional(),
  status:       docStatusEnum.optional(),
  summary:      z.string().max(10_000).optional().nullable(),
  body:         z.string().max(100_000).optional().nullable(),
  external_url: z.string().url("external_url must be a valid URL").max(2000).optional().nullable(),
  owner_id:     z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  change_request_id: z.string().uuid("change_request_id must be a valid UUID").optional().nullable(),
  evidence_type:     z.enum(EVIDENCE_TYPES).optional().nullable(),
  evidence_result:   z.enum(EVIDENCE_RESULTS).optional().nullable(),
  tested_by_label:   z.string().trim().min(1).max(200).optional().nullable(),
  tested_at:         z.string().datetime({ offset: true, message: "tested_at must be an ISO date-time" }).optional().nullable(),
  evidence_note:     z.string().max(5000).optional().nullable(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
