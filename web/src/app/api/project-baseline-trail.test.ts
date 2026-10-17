/**
 * Project baseline trail (migration 0055) at the HTTP edge.
 *
 * An approved rebaseline now moves the PROJECT's own baseline dates as well as
 * its milestones' and tasks', and both the lock and the apply leave the
 * before/after of that baseline in their audit row (after.project_baseline) —
 * the History tab and the Trust Center stream show it.
 *
 * Same harness as lifecycle-guards-2.test.ts: the real route handlers (wrapped
 * by route()) over the in-memory admin client; requireAuth is mocked,
 * requireScope is the real one. Two database behaviours the fake does not have
 * are simulated here, next to the tests that need them:
 *   - the 0049 trigger (a baseline_* write on an already-LOCKED project raises
 *     P0010), so the lock route's write ORDER is observable;
 *   - nopm_apply_rebaseline_snapshot as 0055 defines it (the RPC is stubbed by
 *     the other suites; here it must actually move the rows).
 * The SQL itself is covered by lifecycle-guards-migration.test.ts and the
 * local-DB probes.
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

import { POST as lockProject } from "./projects/[id]/lock/route";
import { POST as applyRebaseline } from "./rebaselines/[id]/apply/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444445";
const STAMP = "2026-10-01T00:00:00.000Z";

const SCOPES = ["project:read", "project:write", "rebaseline:approve"];

function pat(id: string, owner: string): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes: SCOPES,
    principalId: owner,
    principalRole: owner ? "manager" : null,
    channel: "api",
    requestId: `req-${id}`,
  };
}
const alicePat = () => pat("tok-alice", ALICE);
const bobPat = () => pat("tok-bob", BOB);

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(handler: Handler, actor: Actor, id: string, body?: unknown) {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handler(req, { params: Promise.resolve({ id }) });
}

let db: FakeDb;
const row = (table: string, id: string) => db.rows(table).find((r) => r.id === id) as Row;
const project = () => row("projects", PROJECT);
const auditRows = (action: string) => db.rows("audit_log").filter((r) => r.action === action);
const trail = (action: string) => (auditRows(action)[0].after as { project_baseline: unknown }).project_baseline;

// ── simulated database behaviours ─────────────────────────────────────────

// FakeDb has no `.is()`; add it to the builder's prototype for this file only.
const builderProto = Object.getPrototypeOf(new FakeDb().client.from("t")) as {
  is?: (this: { filters: Array<(r: Row) => boolean> }, column: string, value: unknown) => unknown;
};
builderProto.is = function (this, column, value) {
  this.filters.push((r) => (r[column] ?? null) === value);
  return this;
};

/** A query chain whose every step returns itself and whose result is `{ data: null, error }`. */
function failingChain(error: { code: string; message: string }) {
  const result = { data: null, error };
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
        if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(result);
        return () => chain;
      },
    },
  );
  return chain;
}

/** Migration 0049: a baseline_* write on a project that is ALREADY locked raises PROJECT_LOCKED (P0010). */
function simulateProjectBaselineTrigger(fake: FakeDb) {
  const realFrom = fake.client.from;
  fake.client.from = (table: string) => {
    const builder = realFrom(table) as unknown as {
      update: (patch: Row) => unknown;
      eq: (c: string, v: unknown) => unknown;
    };
    if (table === "projects") {
      const update = builder.update.bind(builder);
      builder.update = (patch: Row) => {
        const touchesBaseline = Object.keys(patch).some((k) => k.startsWith("baseline_"));
        if (touchesBaseline && fake.rows("projects").some((p) => p.is_locked)) {
          return failingChain({ code: "P0010", message: "PROJECT_LOCKED: project baseline is frozen" });
        }
        return update(patch);
      };
    }
    return builder as never;
  };
}

// ── seed ──────────────────────────────────────────────────────────────────

function seed(): FakeDb {
  return new FakeDb({
    projects: [
      {
        id: PROJECT,
        workspace_id: WS,
        name: "Billing Migration",
        is_locked: false,
        start_date: "2027-02-01",
        target_date: "2027-08-31",
        baseline_start_date: null,
        baseline_target_date: null,
        updated_at: STAMP,
      },
      { id: OTHER_PROJECT, workspace_id: WS, name: "Other", is_locked: false, start_date: "2027-03-01", target_date: "2027-09-01", baseline_start_date: null, baseline_target_date: null, updated_at: STAMP },
    ],
    milestones: [
      { id: "ms-1", workspace_id: WS, project_id: PROJECT, name: "Go-live", target_date: "2027-08-01", baseline_target_date: null, start_date: null, updated_at: STAMP },
    ],
    tasks: [
      { id: "task-1", workspace_id: WS, project_id: PROJECT, name: "Migrate billing DB", start_date: "2027-02-01", due_date: "2027-02-10", baseline_start_date: null, baseline_due_date: null, updated_at: STAMP },
    ],
    rebaselines: [
      { id: "rb-approved", workspace_id: WS, project_id: PROJECT, version: 1, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    audit_log: [],
    notifications: [],
  });
}

beforeEach(() => {
  db = seed();
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ── lock: the first capture of the project baseline ───────────────────────

describe("POST /projects/:id/lock — captures the project's own baseline, with a trail", () => {
  beforeEach(() => simulateProjectBaselineTrigger(db));

  it("the harness is not vacuous: once locked, a project baseline write is refused with P0010", async () => {
    project().is_locked = true;
    const { error } = await db.client.from("projects").update({ baseline_start_date: "2027-02-01" }).eq("id", PROJECT);
    expect((error as { code?: string } | null)?.code).toBe("P0010");
  });

  it("a null project baseline is captured from the project's dates, BEFORE the lock (the 0049 trigger would refuse it after)", async () => {
    const res = await call(lockProject, alicePat(), PROJECT, { reason: "Q4 baseline" });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    expect(project()).toMatchObject({
      is_locked: true,
      baseline_start_date: "2027-02-01",
      baseline_target_date: "2027-08-31",
    });
    // The children are still snapshotted too, and another project is not touched.
    expect(row("milestones", "ms-1").baseline_target_date).toBe("2027-08-01");
    expect(row("tasks", "task-1").baseline_due_date).toBe("2027-02-10");
    expect(row("projects", OTHER_PROJECT)).toMatchObject({ is_locked: false, baseline_start_date: null, baseline_target_date: null });
  });

  it("an existing project baseline is left alone, even when the dates have moved since; only the missing one is captured", async () => {
    project().baseline_start_date = "2026-12-01"; // set by hand earlier; the plan start has since moved to 2027-02-01
    const res = await call(lockProject, alicePat(), PROJECT);
    expect(res.status).toBe(200);
    expect(project()).toMatchObject({ baseline_start_date: "2026-12-01", baseline_target_date: "2027-08-31" });

    // A fully baselined project is not touched at all.
    db = seed();
    holder.db = db;
    simulateProjectBaselineTrigger(db);
    Object.assign(project(), { baseline_start_date: "2026-12-01", baseline_target_date: "2027-06-30" });
    expect((await call(lockProject, alicePat(), PROJECT)).status).toBe(200);
    expect(project()).toMatchObject({ is_locked: true, baseline_start_date: "2026-12-01", baseline_target_date: "2027-06-30" });
  });

  it("writes one project.lock audit row whose after.project_baseline holds the before and the after", async () => {
    await call(lockProject, alicePat(), PROJECT);
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["project.lock"]);
    expect(trail("project.lock")).toEqual({
      before: { start: null, target: null },
      after: { start: "2027-02-01", target: "2027-08-31" },
    });
    // The rest of the row is what it always was.
    expect(auditRows("project.lock")[0].after).toMatchObject({ is_locked: true });
  });

  it("the trail shows a kept baseline as unchanged, and only the captured one as moved", async () => {
    project().baseline_target_date = "2027-06-30";
    await call(lockProject, alicePat(), PROJECT);
    expect(trail("project.lock")).toEqual({
      before: { start: null, target: "2027-06-30" },
      after: { start: "2027-02-01", target: "2027-06-30" },
    });
  });

  it("a project with no dates has nothing to capture: no baseline written, the trail is null on both sides", async () => {
    Object.assign(project(), { start_date: null, target_date: null });
    const res = await call(lockProject, alicePat(), PROJECT);
    expect(res.status).toBe(200);
    expect(project()).toMatchObject({ is_locked: true, baseline_start_date: null, baseline_target_date: null });
    expect(trail("project.lock")).toEqual({
      before: { start: null, target: null },
      after: { start: null, target: null },
    });
  });

  it("locking an already-locked project writes no baseline (the trigger would refuse it) and the trail is unchanged", async () => {
    Object.assign(project(), { is_locked: true, baseline_start_date: "2026-12-01" });
    const res = await call(lockProject, alicePat(), PROJECT, { reason: "again" });
    expect(res.status).toBe(200);
    expect(project()).toMatchObject({ baseline_start_date: "2026-12-01", baseline_target_date: null, lock_reason: "again" });
    expect(trail("project.lock")).toEqual({
      before: { start: "2026-12-01", target: null },
      after: { start: "2026-12-01", target: null },
    });
  });
});

// ── apply: the project baseline moves, with a trail ───────────────────────

describe("POST /rebaselines/:id/apply — moves the project's baseline and records before / after", () => {
  beforeEach(() => {
    // A locked project whose plan was re-approved: the dates are the new plan, the baselines are the old one.
    Object.assign(project(), {
      is_locked: true,
      start_date: "2027-03-01",
      target_date: "2027-10-31",
      baseline_start_date: "2027-02-01",
      baseline_target_date: "2027-08-31",
    });
  });

  it("the project's baseline becomes its current dates, next to its milestones and tasks, and the rebaseline is applied", async () => {
    const res = await call(applyRebaseline, bobPat(), "rb-approved", {});
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    expect(project()).toMatchObject({ baseline_start_date: "2027-03-01", baseline_target_date: "2027-10-31" });
    expect(row("milestones", "ms-1").baseline_target_date).toBe("2027-08-01");
    expect(row("tasks", "task-1")).toMatchObject({ baseline_start_date: "2027-02-01", baseline_due_date: "2027-02-10" });
    expect(row("rebaselines", "rb-approved")).toMatchObject({ status: "applied" });
    // Another project is not touched.
    expect(row("projects", OTHER_PROJECT).baseline_start_date).toBeNull();
    expect(db.rpcCallsTo("nopm_apply_rebaseline")).toHaveLength(1);
  });

  it("the single rebaseline.apply audit row carries after.project_baseline = { before: the old baseline, after: the new one }", async () => {
    await call(applyRebaseline, bobPat(), "rb-approved", {});
    expect(db.rows("audit_log").map((r) => r.action)).toEqual(["rebaseline.apply"]);
    expect(trail("rebaseline.apply")).toEqual({
      before: { start: "2027-02-01", target: "2027-08-31" },
      after: { start: "2027-03-01", target: "2027-10-31" },
    });
    // The rest of the row is what it always was: the rebaseline before and after.
    const audit = auditRows("rebaseline.apply")[0];
    expect(audit.before).toMatchObject({ id: "rb-approved", status: "approved" });
    expect(audit.after).toMatchObject({ id: "rb-approved", status: "applied" });
  });

  it("a project that never had a baseline shows null on the before side", async () => {
    Object.assign(project(), { baseline_start_date: null, baseline_target_date: null });
    await call(applyRebaseline, bobPat(), "rb-approved", {});
    expect(trail("rebaseline.apply")).toEqual({
      before: { start: null, target: null },
      after: { start: "2027-03-01", target: "2027-10-31" },
    });
  });

  it("the response body is still the applied rebaseline (the trail is audit-only)", async () => {
    const json = await (await call(applyRebaseline, bobPat(), "rb-approved", {})).json();
    expect(json.data).toMatchObject({ id: "rb-approved", status: "applied" });
    expect(json.data).not.toHaveProperty("project_baseline");
  });

  it("a failure inside the apply RPC moves nothing and writes no audit row: the rebaseline stays approved", async () => {
    db.rpcHandlers.nopm_apply_rebaseline = () => ({ data: null, error: { code: "XX000", message: "deadlock detected" } });
    const res = await call(applyRebaseline, bobPat(), "rb-approved", {});
    expect(res.status).toBe(500);
    expect(project()).toMatchObject({ baseline_start_date: "2027-02-01", baseline_target_date: "2027-08-31" });
    expect(row("rebaselines", "rb-approved").status).toBe("approved");
    expect(db.rows("audit_log")).toEqual([]);
  });
});
