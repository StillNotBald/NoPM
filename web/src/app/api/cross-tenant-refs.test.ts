/**
 * Cross-tenant references at the HTTP edge (R1 M3).
 *
 * Drives the real route handlers (wrapped by route()) against an in-memory
 * admin client holding TWO workspaces. For every create/update route that
 * accepts an id pointing at another row, a body that names a row in the OTHER
 * workspace must be refused with 422 `{ error, code: "invalid_reference",
 * fields: [{ field }] }` and leave NO trace: no row written, no audit row. A
 * row in the caller's own workspace, and an explicit null, must still work.
 *
 * Routes owned by the lifecycle wave (projects, rebaselines) use the same helper and are tested there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => undefined,
  emitApprovalDecided: () => undefined,
}));
vi.mock("@/lib/clash/detect", () => ({
  detectOverAllocation: async () => false,
  detectOverAllocationSafe: async () => ({ detected: false, warning: null }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { POST as createTask } from "./projects/[id]/tasks/route";
import { PATCH as patchTask } from "./tasks/[id]/route";
import { POST as createMilestone } from "./projects/[id]/milestones/route";
import { PATCH as patchMilestone } from "./milestones/[id]/route";
import { POST as createRisk } from "./projects/[id]/risks/route";
import { PATCH as patchRisk } from "./risks/[id]/route";
import { POST as createIssue } from "./projects/[id]/issues/route";
import { PATCH as patchIssue } from "./issues/[id]/route";
import { POST as createDecision } from "./projects/[id]/decisions/route";
import { PATCH as patchDecision, DELETE as deleteDecision } from "./decisions/[id]/route";
import { POST as createDocument } from "./documents/route";
import { PATCH as patchDocument } from "./documents/[id]/route";
import { POST as createClash } from "./clashes/route";
import { PATCH as patchClash } from "./clashes/[id]/route";
import { POST as createAllocation } from "./allocations/route";
import { PATCH as patchAllocation } from "./allocations/[id]/route";
import { POST as createProgram } from "./programs/route";
import { PATCH as patchProgram } from "./programs/[id]/route";
import { POST as createResource } from "./resources/route";
import { PATCH as patchResource } from "./resources/[id]/route";

const W1 = "ws-1";
const W2 = "ws-2";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER_W1 = "22222222-2222-4222-8222-222222222222";
const USER_W2 = "33333333-3333-4333-8333-333333333333";
const PROJ_W1 = "44444444-4444-4444-8444-444444444441";
const PROJ_W2 = "44444444-4444-4444-8444-444444444442";
const MEMBER_W1 = "55555555-5555-4555-8555-555555555551";
const MEMBER_W2 = "55555555-5555-4555-8555-555555555552";
const TASK_W1 = "66666666-6666-4666-8666-666666666661";
const TASK_W2 = "66666666-6666-4666-8666-666666666662";
const DEC_W1 = "77777777-7777-4777-8777-777777777771";
const DEC_W1_B = "77777777-7777-4777-8777-777777777773";
const DEC_W2 = "77777777-7777-4777-8777-777777777772";
const MS_W1 = "88888888-8888-4888-8888-888888888881";
const RISK_W1 = "99999999-9999-4999-8999-999999999991";
const ISSUE_W1 = "99999999-9999-4999-8999-999999999992";
const DOC_W1 = "99999999-9999-4999-8999-999999999993";
const CLASH_W1 = "99999999-9999-4999-8999-999999999994";
const ALLOC_W1 = "99999999-9999-4999-8999-999999999995";
const PROG_W1 = "99999999-9999-4999-8999-999999999996";

let db: FakeDb;

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      { id: PROJ_W1, workspace_id: W1, name: "Billing", is_locked: false },
      { id: PROJ_W2, workspace_id: W2, name: "Foreign", is_locked: false },
    ],
    profiles: [
      { id: ADMIN, workspace_id: W1, role: "admin" },
      { id: USER_W1, workspace_id: W1, role: "member" },
      { id: USER_W2, workspace_id: W2, role: "member" },
    ],
    resource_members: [
      { id: MEMBER_W1, workspace_id: W1, name: "Casey" },
      { id: MEMBER_W2, workspace_id: W2, name: "Foreign Casey" },
    ],
    tasks: [
      { id: TASK_W1, workspace_id: W1, project_id: PROJ_W1, name: "Migrate", updated_at: "2026-10-01T00:00:00Z" },
      { id: TASK_W2, workspace_id: W2, project_id: PROJ_W2, name: "Foreign task" },
    ],
    decisions: [
      { id: DEC_W1, workspace_id: W1, project_id: PROJ_W1, reference_id: "DEC-001", title: "Use Postgres" },
      { id: DEC_W1_B, workspace_id: W1, project_id: PROJ_W1, reference_id: "DEC-002", title: "Use Postgres 17" },
      { id: DEC_W2, workspace_id: W2, project_id: PROJ_W2, reference_id: "DEC-001", title: "Foreign decision" },
    ],
    milestones: [{ id: MS_W1, workspace_id: W1, project_id: PROJ_W1, name: "Go-live", updated_at: "2026-10-01T00:00:00Z" }],
    risks: [{ id: RISK_W1, workspace_id: W1, project_id: PROJ_W1, title: "Slip", updated_at: "2026-10-01T00:00:00Z" }],
    issues: [{ id: ISSUE_W1, workspace_id: W1, project_id: PROJ_W1, title: "Bug", updated_at: "2026-10-01T00:00:00Z" }],
    documents: [{ id: DOC_W1, workspace_id: W1, project_id: PROJ_W1, title: "Charter", version: 1, body: null }],
    clashes: [{ id: CLASH_W1, workspace_id: W1, title: "Overlap", type: "schedule", severity: "low", status: "open" }],
    allocations: [{ id: ALLOC_W1, workspace_id: W1, member_id: MEMBER_W1 }],
    programs: [{ id: PROG_W1, workspace_id: W1, name: "Platform" }],
  });
}

function session(): Actor {
  return {
    type: "user",
    id: ADMIN,
    label: "Admin",
    workspaceId: W1,
    role: "admin",
    principalId: ADMIN,
    channel: "ui",
    requestId: "req-1",
  };
}

type Handler = (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: Handler, method: "POST" | "PATCH" | "DELETE", body: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

type Case = {
  name: string;
  handler: Handler;
  method: "POST" | "PATCH";
  params?: Record<string, string>;
  /** Body fields that are always valid for the route. */
  base: Record<string, unknown>;
  /** The reference field under test. */
  field: string;
  foreign: string;
  local: string;
  /** Table the route writes (to prove nothing was written on a refusal). */
  table: string;
};

const P = { id: PROJ_W1 };

const CASES: Case[] = [
  { name: "POST /projects/:id/tasks assignee_id", handler: createTask, method: "POST", params: P, base: { name: "T" }, field: "assignee_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "tasks" },
  { name: "POST /projects/:id/tasks blocked_by", handler: createTask, method: "POST", params: P, base: { name: "T" }, field: "blocked_by", foreign: TASK_W2, local: TASK_W1, table: "tasks" },
  { name: "PATCH /tasks/:id assignee_id", handler: patchTask, method: "PATCH", params: { id: TASK_W1 }, base: {}, field: "assignee_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "tasks" },
  { name: "PATCH /tasks/:id blocked_by", handler: patchTask, method: "PATCH", params: { id: TASK_W1 }, base: {}, field: "blocked_by", foreign: TASK_W2, local: DEC_W1 /* replaced below */, table: "tasks" },
  { name: "POST /projects/:id/tasks backup_assignee_id", handler: createTask, method: "POST", params: P, base: { name: "T" }, field: "backup_assignee_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "tasks" },
  { name: "PATCH /tasks/:id backup_assignee_id", handler: patchTask, method: "PATCH", params: { id: TASK_W1 }, base: {}, field: "backup_assignee_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "tasks" },
  { name: "POST /projects/:id/milestones owner_id", handler: createMilestone, method: "POST", params: P, base: { name: "M" }, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "milestones" },
  { name: "PATCH /milestones/:id owner_id", handler: patchMilestone, method: "PATCH", params: { id: MS_W1 }, base: {}, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "milestones" },
  { name: "POST /projects/:id/risks owner_id", handler: createRisk, method: "POST", params: P, base: { title: "R", severity: "low", likelihood: "low" }, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "risks" },
  { name: "PATCH /risks/:id owner_id", handler: patchRisk, method: "PATCH", params: { id: RISK_W1 }, base: {}, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "risks" },
  { name: "POST /projects/:id/risks backup_owner_id", handler: createRisk, method: "POST", params: P, base: { title: "R", severity: "low", likelihood: "low" }, field: "backup_owner_id", foreign: USER_W2, local: USER_W1, table: "risks" },
  { name: "PATCH /risks/:id backup_owner_id", handler: patchRisk, method: "PATCH", params: { id: RISK_W1 }, base: {}, field: "backup_owner_id", foreign: USER_W2, local: USER_W1, table: "risks" },
  { name: "POST /projects/:id/issues backup_owner_id", handler: createIssue, method: "POST", params: P, base: { title: "I", priority: "low" }, field: "backup_owner_id", foreign: USER_W2, local: USER_W1, table: "issues" },
  { name: "PATCH /issues/:id backup_owner_id", handler: patchIssue, method: "PATCH", params: { id: ISSUE_W1 }, base: {}, field: "backup_owner_id", foreign: USER_W2, local: USER_W1, table: "issues" },
  { name: "POST /projects/:id/issues owner_id", handler: createIssue, method: "POST", params: P, base: { title: "I", priority: "low" }, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "issues" },
  { name: "PATCH /issues/:id owner_id", handler: patchIssue, method: "PATCH", params: { id: ISSUE_W1 }, base: {}, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "issues" },
  { name: "POST /projects/:id/decisions supersedes", handler: createDecision, method: "POST", params: P, base: { title: "D" }, field: "supersedes", foreign: DEC_W2, local: DEC_W1, table: "decisions" },
  { name: "PATCH /decisions/:id supersedes", handler: patchDecision, method: "PATCH", params: { id: DEC_W1_B }, base: {}, field: "supersedes", foreign: DEC_W2, local: DEC_W1, table: "decisions" },
  { name: "POST /documents project_id", handler: createDocument, method: "POST", base: { title: "Doc", doc_type: "plan" }, field: "project_id", foreign: PROJ_W2, local: PROJ_W1, table: "documents" },
  { name: "POST /documents owner_id", handler: createDocument, method: "POST", base: { title: "Doc", doc_type: "plan" }, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "documents" },
  { name: "PATCH /documents/:id project_id", handler: patchDocument, method: "PATCH", params: { id: DOC_W1 }, base: {}, field: "project_id", foreign: PROJ_W2, local: PROJ_W1, table: "documents" },
  { name: "PATCH /documents/:id owner_id", handler: patchDocument, method: "PATCH", params: { id: DOC_W1 }, base: {}, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "documents" },
  { name: "POST /clashes project_a_id", handler: createClash, method: "POST", base: { title: "C", type: "schedule", severity: "low" }, field: "project_a_id", foreign: PROJ_W2, local: PROJ_W1, table: "clashes" },
  { name: "POST /clashes project_b_id", handler: createClash, method: "POST", base: { title: "C", type: "schedule", severity: "low" }, field: "project_b_id", foreign: PROJ_W2, local: PROJ_W1, table: "clashes" },
  { name: "POST /clashes resource_member_id", handler: createClash, method: "POST", base: { title: "C", type: "resource", severity: "low" }, field: "resource_member_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "clashes" },
  { name: "POST /clashes owner_id", handler: createClash, method: "POST", base: { title: "C", type: "schedule", severity: "low" }, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "clashes" },
  { name: "PATCH /clashes/:id owner_id", handler: patchClash, method: "PATCH", params: { id: CLASH_W1 }, base: {}, field: "owner_id", foreign: USER_W2, local: USER_W1, table: "clashes" },
  { name: "PATCH /clashes/:id resource_member_id", handler: patchClash, method: "PATCH", params: { id: CLASH_W1 }, base: {}, field: "resource_member_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "clashes" },
  { name: "POST /allocations member_id", handler: createAllocation, method: "POST", base: { member_id: MEMBER_W1 }, field: "member_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "allocations" },
  { name: "POST /allocations project_id", handler: createAllocation, method: "POST", base: { member_id: MEMBER_W1 }, field: "project_id", foreign: PROJ_W2, local: PROJ_W1, table: "allocations" },
  { name: "POST /allocations task_id", handler: createAllocation, method: "POST", base: { member_id: MEMBER_W1 }, field: "task_id", foreign: TASK_W2, local: TASK_W1, table: "allocations" },
  { name: "PATCH /allocations/:id member_id", handler: patchAllocation, method: "PATCH", params: { id: ALLOC_W1 }, base: {}, field: "member_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "allocations" },
  { name: "PATCH /allocations/:id task_id", handler: patchAllocation, method: "PATCH", params: { id: ALLOC_W1 }, base: {}, field: "task_id", foreign: TASK_W2, local: TASK_W1, table: "allocations" },
  { name: "POST /programs owner_id", handler: createProgram, method: "POST", base: { name: "P" }, field: "owner_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "programs" },
  { name: "PATCH /programs/:id owner_id", handler: patchProgram, method: "PATCH", params: { id: PROG_W1 }, base: {}, field: "owner_id", foreign: MEMBER_W2, local: MEMBER_W1, table: "programs" },
  { name: "POST /resources profile_id", handler: createResource, method: "POST", base: { name: "New hire" }, field: "profile_id", foreign: USER_W2, local: USER_W1, table: "resource_members" },
  { name: "PATCH /resources/:id profile_id", handler: patchResource, method: "PATCH", params: { id: MEMBER_W1 }, base: {}, field: "profile_id", foreign: USER_W2, local: USER_W1, table: "resource_members" },
];

// A task's blocker is another task, not a decision — fix the one case above.
for (const c of CASES) if (c.name === "PATCH /tasks/:id blocked_by") c.local = TASK_W1;

beforeEach(() => {
  db = seed();
  holder.db = db;
  authHolder.actor = session();
});

describe("cross-tenant references are refused (422) and leave no trace", () => {
  it.each(CASES)("$name", async (c) => {
    const rowsBefore = JSON.stringify(db.rows(c.table));
    const auditBefore = db.rows("audit_log").length;

    const res = await call(c.handler, c.method, { ...c.base, [c.field]: c.foreign }, c.params);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_reference");
    expect(body.fields).toEqual([{ field: c.field, message: `${c.field} was not found in this workspace` }]);
    // No write, no audit row.
    expect(JSON.stringify(db.rows(c.table))).toBe(rowsBefore);
    expect(db.rows("audit_log")).toHaveLength(auditBefore);
  });
});

describe("references inside the caller's own workspace still work", () => {
  it.each(CASES)("$name", async (c) => {
    const res = await call(c.handler, c.method, { ...c.base, [c.field]: c.local }, c.params);
    expect(res.status, await res.clone().text()).toBe(c.method === "POST" ? 201 : 200);
    expect(db.rows("audit_log").length).toBeGreaterThan(0);
  });

  it.each(CASES.filter((c) => c.method === "PATCH"))("$name accepts an explicit null (clears the reference)", async (c) => {
    const res = await call(c.handler, c.method, { ...c.base, [c.field]: null }, c.params);
    // member_id is required on an allocation (cannot be cleared) — zod refuses null there.
    if (c.field === "member_id") {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe("decisions.supersedes (the cross-tenant 500)", () => {
  it("a W1 decision cannot supersede a W2 decision, so W2's own delete can never be blocked by it", async () => {
    const res = await call(createDecision, "POST", { title: "Hostile", supersedes: DEC_W2 }, P);
    expect(res.status).toBe(422);
    // Nothing in W1 points at the W2 decision.
    expect(db.rows("decisions").filter((d) => d.supersedes === DEC_W2)).toHaveLength(0);
  });

  it("deleting a decision that another decision supersedes is a 422 rule failure, not a 500", async () => {
    db.rows("decisions").find((d) => d.id === DEC_W1_B)!.supersedes = DEC_W1;
    const res = await call(deleteDecision as Handler, "DELETE", undefined, { id: DEC_W1 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("decision_in_use");
    expect(body.error).toContain("DEC-002");
    expect(db.rows("decisions").some((d) => d.id === DEC_W1)).toBe(true);
  });

  it("an unreferenced decision still deletes (204)", async () => {
    const res = await call(deleteDecision as Handler, "DELETE", undefined, { id: DEC_W1_B });
    expect(res.status).toBe(204);
    expect(db.rows("decisions").some((d) => d.id === DEC_W1_B)).toBe(false);
  });

  it("a decision cannot supersede itself", async () => {
    const res = await call(patchDecision, "PATCH", { supersedes: DEC_W1 }, { id: DEC_W1 });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([{ field: "supersedes", message: "a decision cannot supersede itself" }]);
  });
});

describe("malformed ids never reach the lookup", () => {
  it("a non-UUID owner_id is a zod 422 (unchanged behaviour)", async () => {
    const res = await call(createMilestone, "POST", { name: "M", owner_id: "../unlock" }, P);
    expect(res.status).toBe(422);
  });
});
