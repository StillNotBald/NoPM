/**
 * POST /api/rebaselines/:id/apply — one atomic RPC (nopm_apply_rebaseline, migration
 * 0062) moves the baselines, flips approved -> applied and writes the single audit
 * row; D-16 (approvers only) and D11 (project must still be locked) are enforced.
 *
 * Same harness as project-baseline-trail.test.ts (real route over the in-memory
 * admin client; the RPC is mirrored by test-support/fake-rpcs.ts).
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

import { POST as applyRebaseline } from "./route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const RB = "rb-approved";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const OLD = { start: "2027-02-01", target: "2027-08-31" };

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

function call() {
  authHolder.actor = bobPat();
  const req = new NextRequest(`http://localhost/api/rebaselines/${RB}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return applyRebaseline(req, { params: Promise.resolve({ id: RB }) });
}

let db: FakeDb;
const project = () => db.rows("projects").find((r) => r.id === PROJECT) as Row;
const rebaseline = () => db.rows("rebaselines").find((r) => r.id === RB) as Row;
const applyAudits = () => db.rows("audit_log").filter((r) => r.action === "rebaseline.apply");
const trail = () => (applyAudits()[0].after as { project_baseline: { before: unknown; after: unknown } }).project_baseline;

beforeEach(() => {
  db = new FakeDb({
    projects: [
      {
        id: PROJECT,
        workspace_id: WS,
        name: "Billing Migration",
        is_locked: true,
        start_date: "2027-03-01",
        target_date: "2027-10-31",
        baseline_start_date: OLD.start,
        baseline_target_date: OLD.target,
      },
    ],
    rebaselines: [
      { id: RB, workspace_id: WS, project_id: PROJECT, version: 1, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: MEMBER, workspace_id: WS, role: "member" },
    ],
    audit_log: [],
    notifications: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("apply is atomic: status, baselines and audit row move together", () => {
  it("applies once: baseline moved, status applied, exactly one rebaseline.apply row carrying the project baseline trail", async () => {
    const res = await call();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(rebaseline().status).toBe("applied");
    expect(project()).toMatchObject({ baseline_start_date: "2027-03-01", baseline_target_date: "2027-10-31" });
    expect(applyAudits()).toHaveLength(1);
    expect(trail()).toEqual({ before: OLD, after: { start: "2027-03-01", target: "2027-10-31" } });
    expect(db.rpcCallsTo("nopm_apply_rebaseline")).toHaveLength(1);
  });

  it("a failure inside the RPC changes nothing: still approved, no audit row, and the retry works", async () => {
    const real = db.rpcHandlers.nopm_apply_rebaseline;
    db.rpcHandlers.nopm_apply_rebaseline = () => ({ data: null, error: { code: "XX000", message: "connection reset" } });
    expect((await call()).status).toBe(500);
    expect(rebaseline().status).toBe("approved");
    expect(applyAudits()).toHaveLength(0);
    expect(project()).toMatchObject({ baseline_start_date: OLD.start });

    db.rpcHandlers.nopm_apply_rebaseline = real;
    expect((await call()).status).toBe(200);
    expect(applyAudits()).toHaveLength(1);
    expect(trail().before).toEqual(OLD);
  });

  it("the response is the applied rebaseline; baseline_before bookkeeping and the trail stay out of it", async () => {
    const json = await (await call()).json();
    expect(json.data).toMatchObject({ id: RB, status: "applied" });
    expect(json.data).not.toHaveProperty("baseline_before");
    expect(json.data).not.toHaveProperty("project_baseline");
  });

  it("a second apply is 422 already_applied and writes nothing more", async () => {
    await call();
    const again = await call();
    expect(again.status).toBe(422);
    expect((await again.json()).code).toBe("already_applied");
    expect(applyAudits()).toHaveLength(1);
  });
});

describe("D11 — the project must still be locked", () => {
  it("an approved rebaseline whose project was unlocked is refused with 422 project_not_locked, nothing moves", async () => {
    project().is_locked = false;
    const res = await call();
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("project_not_locked");
    expect(rebaseline().status).toBe("approved");
    expect(project()).toMatchObject({ baseline_start_date: OLD.start, baseline_target_date: OLD.target });
    expect(applyAudits()).toHaveLength(0);
  });
});

describe("D-16 — only admins and managers apply", () => {
  it("a member's token is 403 role_not_permitted before anything is read or written", async () => {
    authHolder.actor = { ...bobPat(), principalId: MEMBER, principalRole: "member" };
    const req = new NextRequest(`http://localhost/api/rebaselines/${RB}/apply`, { method: "POST", body: "{}" });
    const res = await applyRebaseline(req, { params: Promise.resolve({ id: RB }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(rebaseline().status).toBe("approved");
    expect(db.rpcCallsTo("nopm_apply_rebaseline")).toHaveLength(0);
  });

  it("the RPC repeats the rule: a principal whose profile is not admin/manager is refused in SQL (P0018 -> 403)", async () => {
    db.rows("profiles").find((p) => p.id === BOB)!.role = "member"; // demoted after the token was minted
    authHolder.actor = bobPat(); // token still claims manager
    const req = new NextRequest(`http://localhost/api/rebaselines/${RB}/apply`, { method: "POST", body: "{}" });
    const res = await applyRebaseline(req, { params: Promise.resolve({ id: RB }) });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(rebaseline().status).toBe("approved");
  });
});
