/**
 * Approval tiers at the HTTP edge (G1 G2): the deletion and rebaseline raise paths set the tier
 * and the deadline, and the decision routes hold the decider to the tier's role. Same harness as
 * four-eyes-principal.test.ts (real route handlers, in-memory admin client).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";

const { holder, emitted, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  emitted: { requested: [] as Record<string, unknown>[], decided: [] as unknown[] },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: Record<string, unknown>) => void emitted.requested.push(ev),
  emitApprovalDecided: (ev: unknown) => void emitted.decided.push(ev),
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

import { POST as approveDeletion } from "./deletion-requests/[id]/approve/route";
import { POST as signoff } from "./rebaselines/[id]/signoff/route";
import { DELETE as deleteTask } from "./tasks/[id]/route";
import { DELETE as deleteProject } from "./projects/[id]/route";
import { POST as raiseRebaseline } from "./projects/[id]/rebaselines/route";

const WS = "ws-1";
const RAE = "11111111-1111-4111-8111-111111111111"; // manager who raises
const MGR = "22222222-2222-4222-8222-222222222222";
const ADM = "33333333-3333-4333-8333-333333333333";
const ADM2 = "44444444-4444-4444-8444-444444444444"; // a second admin: with fewer than two, a manager may decide (D7)
const H = 3_600_000;

const pat = (id: string, owner: string, role: string, scopes: string[]): Actor =>
  ({ type: "token", id, tokenId: id, label: `${id}-agent`, workspaceId: WS, scopes, principalId: owner, principalRole: role, channel: "api" }) as Actor;
const raiser = () => pat("tok-rae", RAE, "manager", ["task:delete:request", "project:delete:request", "project:write"]);
const manager = () => pat("tok-mgr", MGR, "manager", ["task:delete:approve", "project:delete:approve", "rebaseline:approve"]);
const admin = () => pat("tok-adm", ADM, "admin", ["task:delete:approve", "project:delete:approve", "rebaseline:approve"]);

let db: FakeDb;
function seed(extra: Record<string, Row[]> = {}) {
  db = new FakeDb({
    workspaces: [{ id: WS }],
    projects: [{ id: "proj-1", workspace_id: WS, name: "Billing", is_locked: false, start_date: "2026-11-01", target_date: "2026-12-01" }],
    tasks: [{ id: "task-1", workspace_id: WS, name: "Migrate", project_id: "proj-1" }],
    profiles: [
      { id: RAE, workspace_id: WS, role: "manager" },
      { id: MGR, workspace_id: WS, role: "manager" },
      { id: ADM, workspace_id: WS, role: "admin" },
      { id: ADM2, workspace_id: WS, role: "admin" },
    ],
    deletion_requests: [],
    rebaselines: [],
    rebaseline_signoffs: [],
    audit_log: [],
    notifications: [],
    ...extra,
  });
  holder.db = db;
}

function call(
  handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
  actor: Actor,
  id: string,
  body?: unknown,
  method = "POST",
) {
  authHolder.actor = actor;
  return handler(
    new NextRequest(`http://localhost/api/x/${id}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  seed();
  emitted.requested.length = 0;
  emitted.decided.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deletion requests carry a tier and a deadline (G1, G3)", () => {
  it("a project deletion is high_risk (72 h), a task deletion is normal (48 h); the hub event names the tier", async () => {
    db.tables.projects = [{ id: "proj-1", workspace_id: WS, name: "Billing", is_locked: false }];
    const t0 = Date.now();
    expect((await call(deleteProject, raiser(), "proj-1", { reason: "cancelled" }, "DELETE")).status).toBe(202);
    expect((await call(deleteTask, raiser(), "task-1", { reason: "obsolete" }, "DELETE")).status).toBe(202);
    const [proj, task] = db.rows("deletion_requests");
    expect(proj).toMatchObject({ target_type: "project", tier: "high_risk" });
    expect(task).toMatchObject({ target_type: "task", tier: "normal" });
    expect(Date.parse(String(proj.approval_deadline_at)) - t0).toBeLessThan(72 * H + 60_000);
    expect(Date.parse(String(proj.approval_deadline_at)) - t0).toBeGreaterThan(72 * H - 60_000);
    expect(Date.parse(String(task.approval_deadline_at)) - t0).toBeLessThan(48 * H + 60_000);
    expect(emitted.requested.map((e) => e.tier)).toEqual(["high_risk", "normal"]);
    expect(db.rows("approval_events").map((e) => e.kind)).toEqual(["deadline_set", "deadline_set"]);
  });

  it("the policy can make a task deletion admin-only: a manager is then refused, an admin approves", async () => {
    db.rows("workspaces")[0].approval_policy = { tiers: { normal: { approver_role: "admin" } } };
    await call(deleteTask, raiser(), "task-1", { reason: "obsolete" }, "DELETE");
    const id = String(db.rows("deletion_requests")[0].id);
    const refused = await call(approveDeletion, manager(), id, {});
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("role_not_permitted");
    expect(db.rpcCallsTo("nopm_commit_task_deletion")).toHaveLength(0);
    expect((await call(approveDeletion, admin(), id, {})).status).toBe(200);
  });

  it("a manager approves a normal task deletion as before", async () => {
    await call(deleteTask, raiser(), "task-1", { reason: "obsolete" }, "DELETE");
    const id = String(db.rows("deletion_requests")[0].id);
    expect((await call(approveDeletion, manager(), id, {})).status).toBe(200);
  });

  it("a project deletion cannot be approved by a manager (high_risk -> admin)", async () => {
    db.tables.projects = [{ id: "proj-1", workspace_id: WS, name: "Billing", is_locked: false }];
    await call(deleteProject, raiser(), "proj-1", { reason: "cancelled" }, "DELETE");
    const id = String(db.rows("deletion_requests")[0].id);
    const refused = await call(approveDeletion, manager(), id, {});
    expect(refused.status).toBe(403);
    expect(db.rpcCallsTo("nopm_commit_project_deletion")).toHaveLength(0);
  });
});

describe("rebaselines carry a tier; sign-off is held to its role (G2)", () => {
  beforeEach(() => {
    db.rows("projects")[0].is_locked = true; // a rebaseline is proposed on a locked project
  });

  it("a proposal is normal with a deadline, announced with its tier", async () => {
    const res = await call(raiseRebaseline, raiser(), "proj-1", { reason: "slip" });
    expect(res.status).toBe(201);
    expect(db.rows("rebaselines")[0]).toMatchObject({ tier: "normal" });
    expect(db.rows("rebaselines")[0].approval_deadline_at).toBeTruthy();
    expect(emitted.requested[0]).toMatchObject({ kind: "rebaseline_signoff", tier: "normal" });
  });

  it("when the policy makes rebaselines admin-only, a manager's vote is refused (403) and nothing is recorded", async () => {
    db.rows("workspaces")[0].approval_policy = { tiers: { normal: { approver_role: "admin" } } };
    await call(raiseRebaseline, raiser(), "proj-1", { reason: "slip" });
    const id = String(db.rows("rebaselines")[0].id);
    const refused = await call(signoff, manager(), id, { vote: "go" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("role_not_permitted");
    expect(db.rpcCallsTo("nopm_signoff_rebaseline")).toHaveLength(0);
    expect(db.rows("rebaseline_signoffs")).toHaveLength(0);
    const ok = await call(signoff, admin(), id, { vote: "go" });
    expect(ok.status).toBe(200);
  });
});
