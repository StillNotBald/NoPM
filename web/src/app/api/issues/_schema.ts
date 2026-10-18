import { z } from "zod";

const priorityEnum = z.enum(["low", "medium", "high", "urgent"]);
const statusEnum = z.enum(["open", "in_progress", "resolved", "closed"]);

// Content-enrichment P0 fields (migration 0008_content_enrichment).
const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const issueCategoryEnum = z.enum([
  "technical_fault",
  "resourcing",
  "schedule_delay",
  "cost_overrun",
  "scope_change",
  "organisational",
  "supplier",
  "external_event",
]);

export const createIssueSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  priority: priorityEnum,
  resolution: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional().default("open"),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment P0 fields — all optional/nullable (additive, non-breaking).
  severity: severityEnum.optional(),
  issue_category: issueCategoryEnum.optional().nullable(),
  impact: z.string().optional().nullable(),
  resolution_eta: z.string().date().optional().nullable(),
  resolved_at: z.string().date().optional().nullable(),
  // ── complement seam (0041, R-81) — additive, all optional/nullable ───────────
  source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
  external_ref: z.string().min(1).max(200).nullable().optional(),
  external_url: z
    .string()
    .url()
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), { message: "external_url must be an http(s) URL" })
    .nullable()
    .optional(),
});

export const updateIssueSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  priority: priorityEnum.optional(),
  resolution: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment P0 fields — all optional/nullable (additive, non-breaking).
  severity: severityEnum.optional(),
  issue_category: issueCategoryEnum.optional().nullable(),
  impact: z.string().optional().nullable(),
  resolution_eta: z.string().date().optional().nullable(),
  resolved_at: z.string().date().optional().nullable(),
  // ── complement seam (0041, R-81) — additive, all optional/nullable ───────────
  source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
  external_ref: z.string().min(1).max(200).nullable().optional(),
  external_url: z
    .string()
    .url()
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), { message: "external_url must be an http(s) URL" })
    .nullable()
    .optional(),
  // ── Optimistic concurrency (R-90) — opt-in. When sent, must match the row's
  // current updated_at or the PATCH is rejected with 412 (see @/lib/api/occ).
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
