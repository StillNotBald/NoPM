import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { buildAuditRow, auditPrincipalId } from "@/lib/audit/write";

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));

import { auditedInsert, auditedUpdate, auditedDelete, buildAuditArg, mapAuditedError, targetTypeFor } from "./audited-write";

const W = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const actor: Actor = {
  type: "token", id: "tok-1", label: "agent", workspaceId: W, principalId: "pr-1",
  channel: "mcp", requestId: "req-9", viaConnectorId: "con-1", externalEventId: "ev-1", externalActorRef: "u-7",
};
const db = () => holder.db as FakeDb;

beforeEach(() => {
  holder.db = new FakeDb({ tasks: [{ id: T1, workspace_id: W, name: "A", updated_at: "2026-01-01T00:00:00.000Z" }] });
});

describe("audited-write wrapper", () => {
  it("insert writes the row and exactly one audit row with a null before", async () => {
    const row = await auditedInsert({ table: "tasks", actor, action: "task.create", patch: { name: "B" } });
    expect(row.workspace_id).toBe(W);
    const audit = db().rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "task.create", target_type: "task", target_id: row.id, before: null, after: row });
  });

  it("update returns before and after and audits both", async () => {
    const { before, after } = await auditedUpdate({ table: "tasks", actor, action: "task.update", id: T1, patch: { name: "Z" } });
    expect(before.name).toBe("A");
    expect(after.name).toBe("Z");
    expect(db().rows("audit_log")[0]).toMatchObject({ action: "task.update", before, after });
  });

  it("delete audits the removed row with a null after", async () => {
    const gone = await auditedDelete({ table: "tasks", actor, action: "task.delete", id: T1 });
    expect(gone.id).toBe(T1);
    expect(db().rows("tasks")).toHaveLength(0);
    expect(db().rows("audit_log")[0]).toMatchObject({ before: gone, after: null });
  });

  it("maps a missing row to 404 with the caller's message and writes nothing", async () => {
    await expect(
      auditedUpdate({ table: "tasks", actor, action: "task.update", id: "nope", patch: {}, notFoundMessage: "Task not found" }),
    ).rejects.toMatchObject({ status: 404, message: "Task not found" });
    expect(db().rows("audit_log")).toHaveLength(0);
  });

  it("maps a stale expected_updated_at to 412 and writes nothing", async () => {
    await expect(
      auditedUpdate({ table: "tasks", actor, action: "task.update", id: T1, patch: { name: "Z" }, expectedUpdatedAt: "2025-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 412 });
    expect(db().rows("tasks")[0].name).toBe("A");
    expect(db().rows("audit_log")).toHaveLength(0);
  });

  it("accepts a matching expected_updated_at", async () => {
    const { after } = await auditedUpdate({ table: "tasks", actor, action: "task.update", id: T1, patch: { name: "Z" }, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" });
    expect(after.name).toBe("Z");
  });

  it("an unknown-column style rejection is a generic 500 and is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db().mutateFailure = { code: "P0022", message: "UNKNOWN_COLUMN: tasks.bogus" };
    await expect(auditedInsert({ table: "tasks", actor, action: "task.create", patch: { bogus: 1 } })).rejects.toMatchObject({
      status: 500,
      message: "Internal server error",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("fail-closed: any other RPC error propagates unchanged, with its SQLSTATE, and nothing is written", async () => {
    db().mutateFailure = { code: "23505", message: "duplicate key value" };
    await expect(auditedInsert({ table: "tasks", actor, action: "task.create", patch: { name: "C" } })).rejects.toMatchObject({ code: "23505" });
    expect(db().rows("tasks")).toHaveLength(1);
    expect(db().rows("audit_log")).toHaveLength(0);
  });

  it("the audit row equals the one writeAudit produces for the same input", async () => {
    const { before, after } = await auditedUpdate({ table: "tasks", actor, action: "task.update", id: T1, patch: { name: "Z" } });
    const expected = {
      ...buildAuditRow({ workspaceId: W, actor, action: "task.update", targetType: "task", targetId: T1, before, after }),
      principal_id: auditPrincipalId(actor),
    };
    const got = db().rows("audit_log")[0];
    for (const [k, v] of Object.entries(expected)) expect(got[k], k).toEqual(v);
  });

  it("buildAuditArg carries connector provenance and principal only when the actor has them", () => {
    expect(buildAuditArg(actor, W, "x.y", "x")).toMatchObject({ via_connector_id: "con-1", external_event_id: "ev-1", principal_id: "pr-1", channel: "mcp" });
    const plain: Actor = { type: "user", id: "u1", label: "U", workspaceId: W };
    expect(buildAuditArg(plain, W, "x.y", "x")).toMatchObject({ via_connector_id: null, principal_id: "u1", channel: null });
  });

  it("names the singular target type for every table", () => {
    expect(targetTypeFor("saved_views")).toBe("saved_view");
    expect(targetTypeFor("clashes")).toBe("clash");
    expect(targetTypeFor("expenses")).toBe("expense");
  });

  it("mapAuditedError rethrows an unrecognised error as is", () => {
    const e = { code: "23503", message: "fk" };
    try {
      mapAuditedError(e);
      expect.unreachable();
    } catch (x) {
      expect(x).toBe(e);
    }
  });
});

describe("NO_UPDATED_AT", () => {
  it("a pin on a table without updated_at is a logged generic 500, not a 412", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    holder.db = new FakeDb({ calendar_feeds: [{ id: T1, workspace_id: W, name: "f" }] });
    await expect(
      auditedUpdate({ table: "calendar_feeds", actor, action: "calendar_feed.revoke", id: T1, patch: { revoked_at: "x" }, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ status: 500, message: "Internal server error" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("audited write rejected"), expect.stringContaining("NO_UPDATED_AT"));
    log.mockRestore();
  });

  it("the narrowed sensitive tables refuse columns outside their lifecycle list", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    holder.db = new FakeDb({ profiles: [{ id: T1, workspace_id: W, display_name: "A", role: "member" }] });
    await expect(
      auditedUpdate({ table: "profiles", actor, action: "profile.update", id: T1, patch: { role: "admin" } }),
    ).rejects.toMatchObject({ status: 500 });
    const ok = await auditedUpdate({ table: "profiles", actor, action: "profile.update", id: T1, patch: { display_name: "B" } });
    expect(ok.after.display_name).toBe("B");
    log.mockRestore();
  });
});
