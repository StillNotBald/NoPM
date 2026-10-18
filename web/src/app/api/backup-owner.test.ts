/**
 * Backup owner (M6, R-140) at the HTTP edge: the four write paths accept and
 * return the backup, refuse a backup who is the primary (422), keep it in the
 * audit row, and a PATCH that does not mention it leaves it alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/integrations/emit", () => ({ emitApprovalRequested: () => undefined, emitApprovalDecided: () => undefined }));
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

import { POST as createRisk } from "./projects/[id]/risks/route";
import { PATCH as patchRisk } from "./risks/[id]/route";
import { PATCH as patchIssue } from "./issues/[id]/route";
import { POST as createTask } from "./projects/[id]/tasks/route";
import { PATCH as patchTask } from "./tasks/[id]/route";
import { POST as createProject } from "./projects/route";
import { PATCH as patchProject } from "./projects/[id]/route";

const W1 = "ws-1";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "22222222-2222-4222-8222-222222222223";
const PROJ = "44444444-4444-4444-8444-444444444441";
const MEM_A = "55555555-5555-4555-8555-555555555551";
const MEM_B = "55555555-5555-4555-8555-555555555552";
const MEM_A2 = "55555555-5555-4555-8555-555555555553";
const RISK = "99999999-9999-4999-8999-999999999991";
const ISSUE = "99999999-9999-4999-8999-999999999992";
const TASK = "66666666-6666-4666-8666-666666666661";

let db: FakeDb;

function seed() {
  return new FakeDb({
    projects: [{ id: PROJ, workspace_id: W1, name: "Billing", code: "BIL", owner_id: ALICE, backup_owner_id: null, is_locked: false, rag_status: "green", completion_pct: 0, updated_at: "2026-10-01T00:00:00Z" }],
    profiles: [
      { id: ADMIN, workspace_id: W1, role: "admin" },
      { id: ALICE, workspace_id: W1, role: "member" },
      { id: BOB, workspace_id: W1, role: "member" },
    ],
    resource_members: [
      { id: MEM_A, workspace_id: W1, name: "Alice", profile_id: ALICE },
      { id: MEM_B, workspace_id: W1, name: "Bob", profile_id: BOB },
      { id: MEM_A2, workspace_id: W1, name: "Alice (second row)", profile_id: ALICE },
    ],
    risks: [{ id: RISK, workspace_id: W1, project_id: PROJ, title: "Slip", status: "open", owner_id: ALICE, backup_owner_id: BOB, updated_at: "2026-10-01T00:00:00Z" }],
    issues: [{ id: ISSUE, workspace_id: W1, project_id: PROJ, title: "Bug", status: "open", owner_id: ALICE, backup_owner_id: null, updated_at: "2026-10-01T00:00:00Z" }],
    tasks: [{ id: TASK, workspace_id: W1, project_id: PROJ, name: "Migrate", assignee_id: MEM_A, backup_assignee_id: null, status_type: "started", updated_at: "2026-10-01T00:00:00Z" }],
  });
}

const admin: Actor = { type: "user", id: ADMIN, label: "Admin", workspaceId: W1, role: "admin", principalId: ADMIN, channel: "ui", requestId: "r1" };

type Handler = (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => Promise<Response>;
async function call(handler: Handler, method: "POST" | "PATCH", body: unknown, params: Record<string, string> = {}) {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

beforeEach(() => {
  db = seed();
  holder.db = db;
  authHolder.actor = admin;
});

describe("a backup who is the primary is refused (422), nothing written", () => {
  const cases: Array<[string, Handler, "POST" | "PATCH", Record<string, string>, Record<string, unknown>, string, string]> = [
    ["POST risk, owner = backup", createRisk, "POST", { id: PROJ }, { title: "R", severity: "low", likelihood: "low", owner_id: ALICE, backup_owner_id: ALICE }, "backup_owner_id", "risks"],
    ["PATCH issue, backup = stored owner", patchIssue, "PATCH", { id: ISSUE }, { backup_owner_id: ALICE }, "backup_owner_id", "issues"],
    ["PATCH risk, new owner = stored backup", patchRisk, "PATCH", { id: RISK }, { owner_id: BOB }, "backup_owner_id", "risks"],
    ["POST task, assignee = backup", createTask, "POST", { id: PROJ }, { name: "T", assignee_id: MEM_A, backup_assignee_id: MEM_A }, "backup_assignee_id", "tasks"],
    ["PATCH task, backup = stored assignee", patchTask, "PATCH", { id: TASK }, { backup_assignee_id: MEM_A }, "backup_assignee_id", "tasks"],
    ["PATCH task, backup is another member row of the same login", patchTask, "PATCH", { id: TASK }, { backup_assignee_id: MEM_A2 }, "backup_assignee_id", "tasks"],
    ["POST task, backup is another member row of the same login", createTask, "POST", { id: PROJ }, { name: "T", assignee_id: MEM_A, backup_assignee_id: MEM_A2 }, "backup_assignee_id", "tasks"],
    ["POST project, owner = backup", createProject, "POST", {}, { code: "X", name: "X", owner_id: ALICE, backup_owner_id: ALICE }, "backup_owner_id", "projects"],
    ["PATCH project, backup = stored owner", patchProject, "PATCH", { id: PROJ }, { backup_owner_id: ALICE }, "backup_owner_id", "projects"],
  ];

  it.each(cases)("%s", async (_n, handler, method, params, body, field, table) => {
    const before = JSON.stringify(db.rows(table));
    const audits = db.rows("audit_log").length;
    const res = await call(handler, method, body, params);
    expect(res.status, await res.clone().text()).toBe(422);
    const json = await res.json();
    expect(json.fields).toEqual([{ field, message: expect.stringContaining("different person") }]);
    expect(JSON.stringify(db.rows(table))).toBe(before);
    expect(db.rows("audit_log")).toHaveLength(audits);
  });
});

describe("a valid backup is saved, returned and audited", () => {
  it("PATCH issue: saved, in the response, in the audit after", async () => {
    const res = await call(patchIssue, "PATCH", { backup_owner_id: BOB }, { id: ISSUE });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).data.backup_owner_id).toBe(BOB);
    const audit = db.rows("audit_log").find((a) => a.action === "issue.update");
    expect((audit?.after as { backup_owner_id?: string }).backup_owner_id).toBe(BOB);
  });

  it("PATCH task: backup_assignee_id saved and audited", async () => {
    const res = await call(patchTask, "PATCH", { backup_assignee_id: MEM_B }, { id: TASK });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.rows("tasks")[0].backup_assignee_id).toBe(MEM_B);
    const audit = db.rows("audit_log").find((a) => a.action === "task.update");
    expect((audit?.after as { backup_assignee_id?: string }).backup_assignee_id).toBe(MEM_B);
  });

  it("POST risk with a backup stores it", async () => {
    const res = await call(createRisk, "POST", { title: "R", severity: "low", likelihood: "low", owner_id: ALICE, backup_owner_id: BOB }, { id: PROJ });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await res.json()).data.backup_owner_id).toBe(BOB);
  });

  it("PATCH project: backup saved", async () => {
    const res = await call(patchProject, "PATCH", { backup_owner_id: BOB }, { id: PROJ });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.rows("projects")[0].backup_owner_id).toBe(BOB);
  });

  it("an explicit null clears the backup; a PATCH that omits it leaves it alone", async () => {
    const keep = await call(patchRisk, "PATCH", { title: "Slip again" }, { id: RISK });
    expect(keep.status).toBe(200);
    expect(db.rows("risks")[0].backup_owner_id).toBe(BOB);
    const clear = await call(patchRisk, "PATCH", { backup_owner_id: null }, { id: RISK });
    expect(clear.status).toBe(200);
    expect(db.rows("risks")[0].backup_owner_id).toBeNull();
  });

  it("a non-UUID backup is a 422 before any lookup", async () => {
    const res = await call(patchRisk, "PATCH", { backup_owner_id: "../unlock" }, { id: RISK });
    expect(res.status).toBe(422);
  });
});

describe("post-UAT fixes", () => {
  it("UAT-003: a project edit that sends program: null saves and clears the program", async () => {
    db.rows("projects")[0].program = "Global";
    const res = await call(patchProject, "PATCH", { name: "Billing", program: null, backup_owner_id: BOB }, { id: PROJ });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(db.rows("projects")[0].program).toBeNull();
    expect(db.rows("projects")[0].backup_owner_id).toBe(BOB);
  });

  it("UAT-003: creating a project with program: null is accepted", async () => {
    const res = await call(createProject, "POST", { code: "NEW", name: "New", program: null }, {});
    expect(res.status, await res.clone().text()).toBe(201);
  });

  it("UAT-022: the refusal is plain language, the field name stays in fields", async () => {
    const res = await call(patchProject, "PATCH", { backup_owner_id: ALICE }, { id: PROJ });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.fields[0].field).toBe("backup_owner_id");
    expect(json.fields[0].message).toBe("The backup owner must be a different person from the owner.");
    expect(json.fields[0].message).not.toMatch(/_id/);
  });
});
