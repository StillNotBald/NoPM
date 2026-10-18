/**
 * M1 atomicity, route group 1: the converted handlers keep their request and
 * response contract, write exactly one audit row (inside the same database
 * function as the change), and leave nothing behind when that function fails.
 * The handlers run for real over the in-memory governed database, whose
 * nopm_mutate_audited mirror is the contract of migration 0103.
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
vi.mock("@/lib/notify/publish", () => ({
  notify: async () => undefined,
  resolveWorkspaceApprovers: async () => [],
  resolveProjectOwner: async () => null,
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

import { POST as projectsPost } from "./projects/route";
import { PATCH as projectPatch } from "./projects/[id]/route";
import { PATCH as taskPatch } from "./tasks/[id]/route";
import { PATCH as milestonePatch } from "./milestones/[id]/route";
import { PATCH as issuePatch } from "./issues/[id]/route";
import { POST as clashPost } from "./clashes/route";
import { PATCH as clashPatch, DELETE as clashDelete } from "./clashes/[id]/route";
import { POST as programPost } from "./programs/route";
import { PATCH as programPatch, DELETE as programDelete } from "./programs/[id]/route";
import { POST as sprintPost } from "./sprints/route";
import { POST as sprintStart } from "./sprints/[id]/start/route";
import { POST as sprintAttach, DELETE as sprintDetach } from "./sprints/[id]/tasks/route";
import { POST as viewPost } from "./saved-views/route";
import { POST as viewDuplicate } from "./saved-views/[id]/duplicate/route";
import { POST as resourcePost } from "./resources/route";
import { PATCH as resourcePatch, DELETE as resourceDelete } from "./resources/[id]/route";
import { POST as taskDepPost, DELETE as taskDepDelete } from "./tasks/[id]/dependencies/route";

const W = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const T1 = "44444444-4444-4444-8444-444444444444";
const T2 = "44444444-4444-4444-8444-555555555555";
const M1 = "55555555-5555-4555-8555-555555555555";
const I1 = "66666666-6666-4666-8666-666666666666";
const C1 = "77777777-7777-4777-8777-777777777777";
const G1 = "88888888-8888-4888-8888-888888888888";
const S1 = "99999999-9999-4999-8999-999999999999";
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const V1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAMP = "2026-10-01T00:00:00.000Z";

let db: FakeDb;
const audits = () => db.rows("audit_log");

beforeEach(() => {
  db = new FakeDb({
    projects: [{ id: P1, workspace_id: W, name: "Apollo", code: "APO", completion_pct: 0, is_locked: false, updated_at: STAMP }],
    tasks: [
      { id: T1, workspace_id: W, project_id: P1, name: "Wire", status_type: "todo", updated_at: STAMP, sprint_id: null },
      { id: T2, workspace_id: W, project_id: P1, name: "Test", status_type: "todo", updated_at: STAMP, sprint_id: null },
    ],
    milestones: [{ id: M1, workspace_id: W, project_id: P1, name: "Beta", status: "pending", updated_at: STAMP }],
    issues: [{ id: I1, workspace_id: W, project_id: P1, title: "Bug", status: "open", updated_at: STAMP }],
    clashes: [{ id: C1, workspace_id: W, title: "Overlap", type: "schedule", severity: "high", status: "open" }],
    programs: [{ id: G1, workspace_id: W, name: "Mercury" }],
    sprints: [
      { id: S1, workspace_id: W, project_id: P1, name: "Sprint 1", state: "planned", start_date: "2026-10-01", end_date: "2026-10-14", updated_at: STAMP },
    ],
    resource_members: [{ id: R1, workspace_id: W, name: "Ada" }],
    saved_views: [
      { id: V1, workspace_id: W, owner_id: U, register: "tasks", name: "Mine", config: {}, scope: "personal", protected: false },
    ],
  });
  holder.db = db;
  authHolder.actor = {
    type: "user", id: U, label: "Admin", workspaceId: W, role: "admin", principalId: U, channel: "ui", requestId: "req-1",
  } satisfies Actor;
});

const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const call = (
  handler: (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>,
  method: string,
  body?: unknown,
  params: Record<string, string> = {},
  url = "http://localhost/api/x",
) =>
  handler(
    new NextRequest(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    ctx(params),
  );

describe("create: 201, the row in { data }, one audit row with before null", () => {
  it("project", async () => {
    const res = await call(projectsPost, "POST", { code: "NEW", name: "New" });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ code: "NEW", name: "New", workspace_id: W });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "project.create", target_type: "project", target_id: data.id, before: null });
    expect(audits()[0].after).toMatchObject({ id: data.id });
  });

  it("clash, and a concurrent duplicate (23505) keeps its clean 422", async () => {
    const ok = await call(clashPost, "POST", { title: "Late", type: "schedule", severity: "low" });
    expect(ok.status).toBe(201);
    expect(audits().map((a) => a.action)).toEqual(["clash.create"]);

    db.mutateFailure = { code: "23505", message: "duplicate key value violates unique constraint" };
    const dup = await call(clashPost, "POST", { title: "Late 2", type: "schedule", severity: "low" });
    expect(dup.status).toBe(422);
    expect(((await dup.json()) as { code: string }).code).toBe("duplicate_clash");
    expect(audits()).toHaveLength(1);
  });

  it("program, resource and sprint", async () => {
    expect((await call(programPost, "POST", { name: "Venus" })).status).toBe(201);
    expect((await call(resourcePost, "POST", { name: "Grace" })).status).toBe(201);
    expect((await call(sprintPost, "POST", { project_id: P1, name: "S2", start_date: "2026-10-15", end_date: "2026-10-28" })).status).toBe(201);
    expect(audits().map((a) => a.action)).toEqual(["program.create", "resource.create", "sprint.create"]);
    expect(audits().map((a) => a.target_type)).toEqual(["program", "resource_member", "sprint"]);
  });

  it("saved view, and a duplicate records where it was copied from", async () => {
    const created = await call(viewPost, "POST", { register: "risks", name: "Hot" });
    expect(created.status).toBe(201);
    const dup = await call(viewDuplicate, "POST", {}, { id: V1 });
    expect(dup.status).toBe(201);
    const row = audits()[1];
    expect(row).toMatchObject({ action: "saved_view.create", target_type: "saved_view" });
    expect(row.after).toMatchObject({ duplicated_from: V1 });
    // the stored row never carries the audit-only key
    expect(db.rows("saved_views").some((v) => "duplicated_from" in v)).toBe(false);
  });
});

describe("update: before and after in the audit row, the same response", () => {
  it("project PATCH returns the updated row", async () => {
    const res = await call(projectPatch, "PATCH", { name: "Apollo 2" }, { id: P1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe("Apollo 2");
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "project.update", target_id: P1 });
    expect((audits()[0].before as { name: string }).name).toBe("Apollo");
    expect((audits()[0].after as { name: string }).name).toBe("Apollo 2");
  });

  it("task PATCH: 404 for an unknown id, nothing audited", async () => {
    const res = await call(taskPatch, "PATCH", { name: "x" }, { id: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
    expect(audits()).toHaveLength(0);
  });

  it("task PATCH: a stale expected_updated_at is a 412 that names the current version, nothing written", async () => {
    const res = await call(taskPatch, "PATCH", { name: "Wired", expected_updated_at: "2025-01-01T00:00:00.000Z" }, { id: T1 });
    expect(res.status).toBe(412);
    expect(((await res.json()) as { current_updated_at?: string }).current_updated_at).toBe(STAMP);
    expect(db.rows("tasks")[0].name).toBe("Wire");
    expect(audits()).toHaveLength(0);
  });

  it("task PATCH: losing the race inside the database function is the same 412", async () => {
    db.mutateFailure = { code: "P0021", message: "STALE_ROW" };
    const res = await call(taskPatch, "PATCH", { name: "Wired", expected_updated_at: STAMP }, { id: T1 });
    expect(res.status).toBe(412);
    expect(db.rows("tasks")[0].name).toBe("Wire");
    expect(audits()).toHaveLength(0);
  });

  it("task PATCH: a matching expected_updated_at succeeds", async () => {
    const res = await call(taskPatch, "PATCH", { name: "Wired", expected_updated_at: STAMP }, { id: T1 });
    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0].action).toBe("task.update");
  });

  it("issue PATCH", async () => {
    const res = await call(issuePatch, "PATCH", { priority: "high" }, { id: I1 });
    expect(res.status).toBe(200);
    expect(audits()[0]).toMatchObject({ action: "issue.update", target_type: "issue" });
  });

  it("milestone PATCH: completing with open tasks records the count in the audited after only", async () => {
    db.rows("tasks")[0].milestone_id = M1;
    const refused = await call(milestonePatch, "PATCH", { status: "completed" }, { id: M1 });
    expect(refused.status).toBe(422);
    expect(audits()).toHaveLength(0);

    const res = await call(milestonePatch, "PATCH", { status: "completed", confirm_open_tasks: true }, { id: M1 });
    expect(res.status).toBe(200);
    expect(audits()[0].after).toMatchObject({ status: "completed", completed_with_open_tasks: 1 });
    expect(db.rows("milestones")[0]).not.toHaveProperty("completed_with_open_tasks");
    expect(((await res.json()) as { data: Record<string, unknown> }).data).not.toHaveProperty("completed_with_open_tasks");
  });

  it("clash, program and resource PATCH", async () => {
    expect((await call(clashPatch, "PATCH", { severity: "low" }, { id: C1 })).status).toBe(200);
    expect((await call(programPatch, "PATCH", { name: "Mercury 2" }, { id: G1 })).status).toBe(200);
    expect((await call(resourcePatch, "PATCH", { name: "Ada L" }, { id: R1 })).status).toBe(200);
    expect(audits().map((a) => a.action)).toEqual(["clash.update", "program.update", "resource.update"]);
  });
});

describe("delete: 204 and one audit row with the removed row as before", () => {
  it("clash, program and resource", async () => {
    for (const [h, id] of [[clashDelete, C1], [programDelete, G1], [resourceDelete, R1]] as const) {
      const res = await call(h, "DELETE", undefined, { id });
      expect(res.status).toBe(204);
    }
    expect(audits().map((a) => a.action)).toEqual(["clash.delete", "program.delete", "resource.delete"]);
    expect(audits().every((a) => a.after === null && a.before !== null)).toBe(true);
    expect(db.rows("clashes")).toHaveLength(0);
  });
});

describe("audit events that are not 'this row changed'", () => {
  it("sprint start audits the committed points, not the sprint row", async () => {
    db.rows("tasks")[0].sprint_id = S1;
    db.rows("tasks")[0].story_points = 5;
    const res = await call(sprintStart, "POST", undefined, { id: S1 });
    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "sprint.started", target_id: S1, after: { committed_points: 5, task_count: 1 } });
    expect((audits()[0].before as { state: string }).state).toBe("planned");
    expect(db.rows("sprints")[0].state).toBe("active");
  });

  it("a sprint start that loses the race is the same 422 as before", async () => {
    db.mutateFailure = { code: "P0021", message: "STALE_ROW" };
    const res = await call(sprintStart, "POST", undefined, { id: S1 });
    expect(res.status).toBe(422);
    expect(db.rows("sprints")[0].state).toBe("planned");
    expect(audits()).toHaveLength(0);
  });

  it("attaching and detaching a task writes the task and audits against the sprint", async () => {
    const attach = await call(sprintAttach, "POST", { task_id: T1 }, { id: S1 });
    expect(attach.status).toBe(200);
    expect(db.rows("tasks")[0].sprint_id).toBe(S1);
    expect(audits()[0]).toMatchObject({ action: "sprint.task_added", target_type: "sprint", target_id: S1, before: null, after: { task_id: T1 } });

    const detach = await call(sprintDetach, "DELETE", undefined, { id: S1 }, `http://localhost/api/sprints/${S1}/tasks?task_id=${T1}`);
    expect(detach.status).toBe(200);
    expect(db.rows("tasks")[0].sprint_id).toBeNull();
    expect(audits()[1]).toMatchObject({ action: "sprint.task_removed", target_id: S1, after: { task_id: T1 } });
  });

  it("a task dependency audits against the successor task and is removed again", async () => {
    const add = await call(taskDepPost, "POST", { predecessor_id: T1, type: "FS", lag_days: 0 }, { id: T2 });
    expect(add.status).toBe(201);
    expect(audits()[0]).toMatchObject({ action: "task_dependency.create", target_type: "task", target_id: T2, before: null });
    const del = await call(taskDepDelete, "DELETE", { predecessor_id: T1 }, { id: T2 });
    expect(del.status).toBe(204);
    expect(audits()[1]).toMatchObject({ action: "task_dependency.delete", target_id: T2, after: null });
    expect(db.rows("task_dependencies")).toHaveLength(0);
  });
});

describe("fail-closed: when the database function fails, neither the change nor an audit row exists", () => {
  it("project create answers 500 and writes nothing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.mutateFailure = { code: "XX000", message: "audit insert failed" };
    const res = await call(projectsPost, "POST", { code: "NEW", name: "New" });
    expect(res.status).toBe(500);
    expect(db.rows("projects")).toHaveLength(1);
    expect(audits()).toHaveLength(0);
    log.mockRestore();
  });

  it("task update answers 500 and leaves the task as it was", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.mutateFailure = { code: "XX000", message: "audit insert failed" };
    const res = await call(taskPatch, "PATCH", { name: "Changed" }, { id: T1 });
    expect(res.status).toBe(500);
    expect(db.rows("tasks")[0].name).toBe("Wire");
    expect(audits()).toHaveLength(0);
    log.mockRestore();
  });
});
