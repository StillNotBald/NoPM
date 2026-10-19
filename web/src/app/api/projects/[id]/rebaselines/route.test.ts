/**
 * POST /api/projects/:id/rebaselines — D4: a second proposal while one already
 * waits for sign-off (unique index uniq_pending_rebaseline) is a 409 conflict
 * with a clear message, not a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { installAtomicGovernance } from "@/lib/governance/test-support/fake-atomic-governance";

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

import { POST } from "./route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

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

function call(body: unknown) {
  authHolder.actor = alice();
  const req = new NextRequest(`http://localhost/api/projects/${PROJECT}/rebaselines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: PROJECT }) });
}

let db: FakeDb;

beforeEach(() => {
  db = installAtomicGovernance(new FakeDb({
    projects: [{ id: PROJECT, workspace_id: WS, name: "Billing", is_locked: true }],
    rebaselines: [],
    audit_log: [],
  }));
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("D4 — one rebaseline waiting for sign-off per project", () => {
  it("a proposal on a locked project is created pending_approval", async () => {
    const res = await call({ reason: "dates slipped" });
    expect(res.status).toBe(201);
    expect(db.rows("rebaselines")[0]).toMatchObject({ status: "pending_approval" });
  });

  async function collide(constraint: string) {
    // The unique violation is raised inside nopm_propose_rebaseline (one transaction, nothing written).
    db.client.rpc = (async () => ({
      data: null,
      error: { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` },
    })) as never;
    return call({ reason: "again" });
  }

  it("the pending index violation (23505) is 409 pending_rebaseline_exists, nothing audited", async () => {
    const res = await collide("uniq_pending_rebaseline");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "A rebaseline is already waiting for sign-off. Withdraw it or wait for the decision.",
      code: "pending_rebaseline_exists",
    });
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("R-15: a (project, version) collision is 409 rebaseline_version_conflict, not 'already waiting'", async () => {
    const res = await collide("rebaselines_project_id_version_key");
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("rebaseline_version_conflict");
    expect(json.error).not.toContain("already has a rebaseline waiting");
    expect(db.rows("audit_log")).toHaveLength(0);
  });
});

describe("Q-GOV-4 / Q-GOV-8 — propose only on a locked project, with the exact dates", () => {
  it("an unlocked project is refused (422 project_not_locked) and nothing is stored", async () => {
    db.rows("projects")[0].is_locked = false;
    const res = await call({ reason: "dates slipped" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "Lock the project dates first, then propose the rebaseline.",
      code: "project_not_locked",
    });
    expect(db.rows("rebaselines")).toHaveLength(0);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("the proposal records the baseline it replaces and the locked dates it proposes", async () => {
    Object.assign(db.rows("projects")[0], {
      start_date: "2027-01-04",
      target_date: "2027-06-30",
      baseline_start_date: "2026-12-01",
      baseline_target_date: "2027-05-31",
    });
    const res = await call({ reason: "scope grew", after: "Go-live 30 Jun" });
    expect(res.status).toBe(201);
    expect(db.rows("rebaselines")[0]).toMatchObject({
      status: "pending_approval",
      before: { start_date: "2026-12-01", target_date: "2027-05-31" },
      after: { start_date: "2027-01-04", target_date: "2027-06-30", note: "Go-live 30 Jun" },
    });
  });
});
