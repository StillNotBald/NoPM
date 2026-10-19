import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// Raising with an assigned approver (G5), against the hub's in-memory database.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("@/lib/governance/next-ref", () => ({
  insertWithReference: async (_db: unknown, _ws: string, _kind: string, insert: (ref: string) => PromiseLike<unknown>) =>
    insert("CR-001"),
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { resolveAssignedApprover } from "@/lib/review/assignee";
import { installAtomicGovernance } from "@/lib/governance/test-support/fake-atomic-governance";
import { POST } from "./route";

const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";
const requester = (): Actor => ({
  type: "user",
  id: ids.requester,
  label: "Rae Requester",
  workspaceId: WS,
  role: "manager",
  principalId: ids.requester,
});

let db: FakeDb;

const raise = (body: Record<string, unknown>) =>
  POST(
    new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/change-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROJECT }) },
  );

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(requester());
  db = installAtomicGovernance(new FakeDb());
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: PROJECT, workspace_id: WS, name: "Apollo" }]);
});

describe("raising a change request with assigned_approver_id", () => {
  it("assigns an admin or manager of the workspace and records it in the audit row", async () => {
    const res = await raise({ title: "Rename a label", assigned_approver_id: ids.manager });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.assigned_approver_id).toBe(ids.manager);
    // wave 5: the audit row is written inside the database function, in the same transaction as the request
    const audit = db.rows("audit_log").filter((a) => a.action === "change_request.create");
    expect(audit).toHaveLength(1);
    expect((audit[0].after as Record<string, unknown>).assigned_approver_id).toBe(ids.manager);
  });

  it("still raises with nobody assigned, and does not send the column at all", async () => {
    const res = await raise({ title: "Rename a label" });
    expect(res.status).toBe(201);
    const stored = db.rows("change_requests").find((r) => r.title === "Rename a label")!;
    expect("assigned_approver_id" in stored).toBe(false);
  });

  it.each([
    ["a member", ids.member],
    ["a viewer", ids.viewer],
    ["the requester themselves", ids.requester],
    ["someone who is not in the workspace", "a0000000-0000-4000-8000-0000000000ff"],
  ])("refuses %s with 422 and raises nothing", async (_label, assignee) => {
    const res = await raise({ title: "Rename a label", assigned_approver_id: assignee });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toEqual([expect.objectContaining({ field: "assigned_approver_id" })]);
    expect(db.rows("change_requests").some((r) => r.title === "Rename a label")).toBe(false);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("422s a value that is not a profile id", async () => {
    expect((await raise({ title: "x", assigned_approver_id: "not-a-uuid" })).status).toBe(422);
  });

  it("resolveAssignedApprover treats null and empty as nobody", async () => {
    expect(await resolveAssignedApprover(db as never, WS, null, ids.requester)).toBeNull();
    expect(await resolveAssignedApprover(db as never, WS, undefined, ids.requester)).toBeNull();
  });

  it("never accepts an approver from another workspace", async () => {
    db.seed("profiles", [{ id: "a0000000-0000-4000-8000-0000000000ee", workspace_id: "other-ws", role: "admin" }]);
    await expect(
      resolveAssignedApprover(db as never, WS, "a0000000-0000-4000-8000-0000000000ee", ids.requester),
    ).rejects.toMatchObject({ status: 422 });
  });
});
