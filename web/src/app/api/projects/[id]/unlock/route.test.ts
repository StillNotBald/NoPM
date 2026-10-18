/**
 * POST /api/projects/:id/unlock — unlocking cancels the project's pending and
 * approved rebaselines (owner decision 2026-10-17, migration 0058).
 *
 * Why it matters: nopm_apply_rebaseline_snapshot copies the LIVE dates at apply
 * time, so a sign-off must never survive "unlock, edit the dates, relock".
 *
 * Same harness as the apply route test: the real routes over the in-memory
 * admin client. nopm_unlock_project_audited is simulated by `unlockRpc` below, which
 * mirrors the SQL of migration 0058 (the SQL itself is covered by the
 * migration-text test and the local-DB probes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => {},
  emitApprovalDecided: () => {},
  emitApprovalChanged: () => {},
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

import { POST as unlock } from "./route";
import { POST as apply } from "@/app/api/rebaselines/[id]/apply/route";
import { POST as signoff } from "@/app/api/rebaselines/[id]/signoff/route";

const WS = "ws-1";
const OTHER_WS = "ws-2";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const P1 = "44444444-4444-4444-8444-444444444444";
const P2 = "55555555-5555-4555-8555-555555555555";
const P3 = "66666666-6666-4666-8666-666666666666"; // another workspace

const alice = (): Actor => ({
  type: "user",
  id: ALICE,
  label: "alice",
  workspaceId: WS,
  role: "admin",
  principalId: ALICE,
  channel: "ui",
  requestId: "req-alice",
});
const bobPat = (): Actor => ({
  type: "token",
  id: "tok-bob",
  tokenId: "tok-bob",
  label: "bob-agent",
  workspaceId: WS,
  scopes: ["rebaseline:approve"],
  principalId: BOB,
  principalRole: "manager",
  channel: "api",
  requestId: "req-bob",
});

let db: FakeDb;
const rb = (id: string) => db.rows("rebaselines").find((r) => r.id === id) as Row;
const audits = (action: string) => db.rows("audit_log").filter((r) => r.action === action);

function callUnlock(project: string, body: unknown = { reason: "fix the target date" }) {
  authHolder.actor = alice();
  const req = new NextRequest(`http://localhost/api/projects/${project}/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return unlock(req, { params: Promise.resolve({ id: project }) });
}

beforeEach(() => {
  db = new FakeDb({
    projects: [
      { id: P1, workspace_id: WS, name: "Billing", is_locked: true, locked_by: ALICE, locked_at: "2026-10-01T00:00:00Z", lock_reason: "freeze", start_date: "2027-03-01", target_date: "2027-10-31" },
      { id: P2, workspace_id: WS, name: "Other", is_locked: true, locked_by: ALICE, locked_at: "2026-10-01T00:00:00Z", lock_reason: "freeze" },
      { id: P3, workspace_id: OTHER_WS, name: "Foreign", is_locked: true, locked_by: ALICE, locked_at: "2026-10-01T00:00:00Z", lock_reason: "freeze" },
    ],
    rebaselines: [
      { id: "rb-pending", workspace_id: WS, project_id: P1, version: 4, status: "pending_approval", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-approved", workspace_id: WS, project_id: P1, version: 3, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-applied", workspace_id: WS, project_id: P1, version: 2, status: "applied", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-rejected", workspace_id: WS, project_id: P1, version: 1, status: "rejected", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-draft", workspace_id: WS, project_id: P1, version: 5, status: "draft", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-other-project", workspace_id: WS, project_id: P2, version: 1, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-other-ws", workspace_id: OTHER_WS, project_id: P3, version: 1, status: "pending_approval", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    rebaseline_signoffs: [],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    audit_log: [],
    notifications: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("unlock cancels the project's open rebaselines", () => {
  it("pending_approval and approved become cancelled; applied, rejected and draft are left alone", async () => {
    const res = await callUnlock(P1);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(rb("rb-pending").status).toBe("cancelled");
    expect(rb("rb-approved").status).toBe("cancelled");
    expect(rb("rb-applied").status).toBe("applied");
    expect(rb("rb-rejected").status).toBe("rejected");
    expect(rb("rb-draft").status).toBe("draft");
  });

  it("the project is unlocked in the same call and the response is the unlocked project", async () => {
    const json = await (await callUnlock(P1)).json();
    expect(json.data).toMatchObject({ id: P1, is_locked: false, locked_by: null, lock_reason: null });
    expect(json.data).not.toHaveProperty("cancelled");
  });

  it("another project and another workspace are untouched", async () => {
    await callUnlock(P1);
    expect(rb("rb-other-project").status).toBe("approved");
    expect(rb("rb-other-ws").status).toBe("pending_approval");
    expect(db.rows("projects").find((p) => p.id === P2)?.is_locked).toBe(true);
    expect(db.rows("projects").find((p) => p.id === P3)?.is_locked).toBe(true);
  });

  it("goes through ONE atomic RPC scoped to the actor's workspace (no separate unlock write)", async () => {
    await callUnlock(P1);
    expect(db.rpcCallsTo("nopm_unlock_project_audited")).toHaveLength(1);
    expect(db.rpcCallsTo("nopm_unlock_project_audited")[0].args).toMatchObject({
      p_project_id: P1,
      p_workspace_id: WS,
      p_reason: "fix the target date",
      p_actor_id: ALICE,
    });
  });

  it("a project with nothing open still unlocks and records an empty cancelled list", async () => {
    db.rows("rebaselines").splice(0, db.rows("rebaselines").length);
    const res = await callUnlock(P1);
    expect(res.status).toBe(200);
    expect(audits("project.unlock")).toHaveLength(1);
    expect((audits("project.unlock")[0].after as Record<string, unknown>).cancelled_rebaselines).toEqual([]);
    expect(audits("rebaseline.cancelled")).toHaveLength(0);
  });
});

describe("unlock audit trail", () => {
  it("project.unlock lists the cancelled rebaseline ids next to the unlock reason", async () => {
    await callUnlock(P1);
    const rows = audits("project.unlock");
    expect(rows).toHaveLength(1);
    const after = rows[0].after as Record<string, unknown>;
    expect(after.unlock_reason).toBe("fix the target date");
    expect((after.cancelled_rebaselines as string[]).slice().sort()).toEqual(["rb-approved", "rb-pending"]);
    expect(after).toMatchObject({ is_locked: false });
  });

  it("writes one rebaseline.cancelled row per cancelled rebaseline, with the previous status and both reasons", async () => {
    await callUnlock(P1);
    const rows = audits("rebaseline.cancelled");
    expect(rows.map((r) => r.target_id).sort()).toEqual(["rb-approved", "rb-pending"]);
    for (const r of rows) {
      expect(r.target_type).toBe("rebaseline");
      expect(r.after).toMatchObject({
        project_id: P1,
        status: "cancelled",
        reason: "project_unlocked",
        unlock_reason: "fix the target date",
      });
    }
    const approved = rows.find((r) => r.target_id === "rb-approved") as Row;
    expect(approved.before).toMatchObject({ status: "approved", version: 3 });
    const pending = rows.find((r) => r.target_id === "rb-pending") as Row;
    expect(pending.before).toMatchObject({ status: "pending_approval", version: 4 });
  });

  it("the reason is still required (R-83): a blank body 422s and cancels nothing", async () => {
    const res = await callUnlock(P1, {});
    expect(res.status).toBe(422);
    expect(rb("rb-approved").status).toBe("approved");
    expect(db.rpcCallsTo("nopm_unlock_project_audited")).toHaveLength(0);
    expect(audits("project.unlock")).toHaveLength(0);
  });
});

describe("fail-closed", () => {
  it("if the RPC fails the call fails and nothing changes (the unlock cannot stand without the cancellation)", async () => {
    db.rpcHandlers.nopm_unlock_project_audited = () => ({ data: null, error: { message: "connection reset", code: "XX000" } });
    const res = await callUnlock(P1);
    expect(res.status).toBe(500);
    expect(db.rows("projects").find((p) => p.id === P1)?.is_locked).toBe(true);
    expect(rb("rb-approved").status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a database without migration 0058 fails the unlock instead of unlocking without cancelling", async () => {
    delete db.rpcHandlers.nopm_unlock_project_audited;
    const res = await callUnlock(P1);
    expect(res.status).toBe(500);
    expect(db.rows("projects").find((p) => p.id === P1)?.is_locked).toBe(true);
    expect(rb("rb-approved").status).toBe("approved");
  });

  it("an unknown project is a 404 and cancels nothing", async () => {
    const res = await callUnlock("77777777-7777-4777-8777-777777777777");
    expect(res.status).toBe(404);
    expect(rb("rb-approved").status).toBe("approved");
  });
});

describe("a cancelled rebaseline can no longer be decided or applied", () => {
  async function callApply(id: string) {
    authHolder.actor = bobPat();
    const req = new NextRequest(`http://localhost/api/rebaselines/${id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return apply(req, { params: Promise.resolve({ id }) });
  }
  async function callSignoff(id: string) {
    authHolder.actor = bobPat();
    const req = new NextRequest(`http://localhost/api/rebaselines/${id}/signoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vote: "go" }),
    });
    return signoff(req, { params: Promise.resolve({ id }) });
  }

  it("apply: the previously APPROVED one is refused with 422 and the baselines do not move", async () => {
    await callUnlock(P1);
    db.rpcHandlers.nopm_apply_rebaseline_snapshot = () => {
      throw new Error("the snapshot must not run for a cancelled rebaseline");
    };
    const res = await callApply("rb-approved");
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/cancelled/);
    expect(rb("rb-approved").status).toBe("cancelled");
    expect(db.rpcCallsTo("nopm_apply_rebaseline_snapshot")).toHaveLength(0);
    expect(audits("rebaseline.apply")).toHaveLength(0);
  });

  it("sign-off: the previously PENDING one is refused with 422 rebaseline_not_pending and records no vote", async () => {
    await callUnlock(P1);
    const res = await callSignoff("rb-pending");
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("rebaseline_not_pending");
    expect(db.rows("rebaseline_signoffs")).toHaveLength(0);
    expect(rb("rb-pending").status).toBe("cancelled");
  });
});
