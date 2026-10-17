import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert }) }),
}));

import { writeAudit, systemActor, auditPrincipalId, isSystemActor, SYSTEM_ACTOR_ID } from "./write";
import type { Actor } from "@/lib/auth/guard";

const base = { workspaceId: "w1", action: "task.create", targetType: "task" } as const;
const user: Actor = { type: "user", id: "u1", label: "U", workspaceId: "w1", channel: "ui" };
const token: Actor = { type: "token", id: "t1", label: "T", workspaceId: "w1", principalId: "creator1" };

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ error: null });
});

describe("writeAudit principal_id (A3-12)", () => {
  it("records the session user as their own principal", async () => {
    await writeAudit({ ...base, actor: user });
    expect(insert.mock.calls[0][0].principal_id).toBe("u1");
  });
  it("records the PAT creator for a token actor", async () => {
    await writeAudit({ ...base, actor: token });
    expect(insert.mock.calls[0][0]).toMatchObject({ actor_id: "t1", principal_id: "creator1" });
  });
  it("omits principal_id for a legacy token with no creator", async () => {
    await writeAudit({ ...base, actor: { ...token, principalId: null } });
    expect("principal_id" in insert.mock.calls[0][0]).toBe(false);
  });
  it("retries without principal_id when the column is not migrated yet", async () => {
    insert
      .mockResolvedValueOnce({ error: { message: 'column "principal_id" of relation "audit_log" does not exist' } })
      .mockResolvedValueOnce({ error: null });
    await writeAudit({ ...base, actor: user });
    expect(insert).toHaveBeenCalledTimes(2);
    expect("principal_id" in insert.mock.calls[1][0]).toBe(false);
  });
  it("still fails closed on any other error", async () => {
    insert.mockResolvedValue({ error: { message: "boom" } });
    await expect(writeAudit({ ...base, actor: user })).rejects.toThrow(/Fail-closed/);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("systemActor (A3-10)", () => {
  it("is a fixed, recognisable, human-less actor", () => {
    const a = systemActor("w1", "digest");
    expect(a).toMatchObject({ id: SYSTEM_ACTOR_ID, label: "system:digest", workspaceId: "w1", principalId: null });
    expect(isSystemActor(a)).toBe(true);
    expect(isSystemActor(user)).toBe(false);
    expect(auditPrincipalId(a)).toBeNull();
  });
  it("R-12: a token merely NAMED system:* is not the system actor", () => {
    expect(isSystemActor({ id: "t-1", type: "token", label: "system:cron" })).toBe(false);
    expect(isSystemActor({ id: SYSTEM_ACTOR_ID, type: "user", label: "system:x" })).toBe(false);
    expect(isSystemActor({ id: SYSTEM_ACTOR_ID, type: "token", label: "someone" })).toBe(false);
    expect(isSystemActor({ id: SYSTEM_ACTOR_ID, type: "token", label: "system:cron" })).toBe(true);
  });
});
