import { z } from "zod";
import { assignedApproverIdField } from "@/lib/review/assignee";
import { parsePullRef } from "@/lib/integrations/github/refs";

export const StatusType = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

export const Priority = z.enum(["low", "medium", "high", "urgent"]);

export const ChecklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  done: z.boolean(),
});

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

/**
 * A GitHub link (source "github", or any external_ref that starts "github:") must be exactly
 * github:<owner>/<repo>#<number>, in lower case: the GitHub webhook looks tasks up by that string, so a
 * misspelt or mixed-case link would silently never move the task (R-153).
 */
function checkGithubRef(v: { source?: string | null; external_ref?: string | null }, ctx: z.RefinementCtx) {
  const ref = v.external_ref;
  if (ref === undefined || ref === null) return;
  if (v.source !== "github" && !ref.startsWith("github:")) return;
  if (ref !== ref.toLowerCase() || parsePullRef(ref) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["external_ref"],
      message: "external_ref for GitHub must be github:<owner>/<repo>#<number> in lower case",
    });
  }
}

export const TaskCreateSchema = z.object({
  // id/workspace_id/project_id are taken from the route, ignored from body
  project_id: z.string().uuid("project_id must be a UUID").optional(),
  milestone_id: z.string().uuid("milestone_id must be a UUID").nullable().optional(),
  name: z.string().min(1, "name is required").max(255),
  description: z.string().nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  status_type: StatusType.optional().default("backlog"),
  assignee_id: z.string().uuid("assignee_id must be a UUID").nullable().optional(),
  backup_assignee_id: z.string().uuid("backup_assignee_id must be a UUID").nullable().optional(),
  priority: Priority.optional().default("medium"),
  start_date: z.string().nullable().optional(), // ISO date string
  due_date: z.string().nullable().optional(),
  completion_pct: z.number().int().min(0).max(100).optional().default(0),
  sort_order: z.number().int().optional(),
  // ── content-enrichment (0008) — additive, all optional/nullable ──────────────
  acceptance_criteria: z.string().nullable().optional(),
  estimate_hours: z.number().min(0, "estimate_hours must be >= 0").nullable().optional(),
  story_points: z.number().min(0, "story_points must be >= 0").nullable().optional(),
  labels: z.array(z.string()).optional(),
  blocked_by: z.string().uuid("blocked_by must be a UUID").nullable().optional(),
  checklist: z.array(ChecklistItemSchema).nullable().optional(),
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
}).superRefine(checkGithubRef);

export const TaskUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  status_type: StatusType.optional(),
  assignee_id: z.string().uuid("assignee_id must be a UUID").nullable().optional(),
  backup_assignee_id: z.string().uuid("backup_assignee_id must be a UUID").nullable().optional(),
  priority: Priority.optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  completion_pct: z.number().int().min(0).max(100).optional(),
  sort_order: z.number().int().optional(),
  milestone_id: z.string().uuid("milestone_id must be a UUID").nullable().optional(),
  // ── content-enrichment (0008) — additive, all optional/nullable ──────────────
  acceptance_criteria: z.string().nullable().optional(),
  estimate_hours: z.number().min(0, "estimate_hours must be >= 0").nullable().optional(),
  story_points: z.number().min(0, "story_points must be >= 0").nullable().optional(),
  labels: z.array(z.string()).optional(),
  blocked_by: z.string().uuid("blocked_by must be a UUID").nullable().optional(),
  checklist: z.array(ChecklistItemSchema).nullable().optional(),
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
}).strict().superRefine(checkGithubRef);

export const TaskDeleteRequestSchema = z.object({
  reason: z.string().min(1, "reason is required").max(1000),
  // G5: optional named approver (an admin or manager of the workspace, not the requester).
  assigned_approver_id: assignedApproverIdField,
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type TaskDeleteRequestInput = z.infer<typeof TaskDeleteRequestSchema>;
