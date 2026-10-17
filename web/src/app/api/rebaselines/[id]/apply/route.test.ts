/**
 * POST /api/rebaselines/:id/apply — the project baseline's TRUE "before" is
 * captured once, before the snapshot RPC moves it, and survives a retry.
 *
 * Same harness as project-baseline-trail.test.ts (real route over the
 * in-memory admin client). Two database behaviours the fake lacks are
 * simulated here: nopm_apply_rebaseline_snapshot (moves the project baseline)
 * and the write-once trigger of migration 0057.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row, type RpcHandler } from "@/lib/governance/test-support/fake-admin";

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
const OLD = { start: "2027-02-01", target: "2027-08-31" };

const bobPat = (): Actor => ({
  type: "token",
  id: "tok-bob",
  tokenId: "tok-bob",
  label: "bob-agent",
  workspaceId: WS,
  scopes: ["rebaseline:approve"],
  principalId: BOB,
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

/** nopm_apply_rebaseline_snapshot (0055), project row only. */
const snapshot: RpcHandler = (args, fake) => {
  for (const p of fake.rows("projects").filter((r) => r.id === args.p_project_id)) {
    p.baseline_start_date = p.start_date;
    p.baseline_target_date = p.target_date;
  }
  return { data: null, error: null };
};

/** Migration 0057: baseline_before is write-once (the trigger keeps the first non-null value). */
function simulateWriteOnce(fake: FakeDb) {
  const realFrom = fake.client.from;
  fake.client.from = (table: string) => {
    const builder = realFrom(table) as unknown as { update: (patch: Row) => unknown };
    if (table === "rebaselines") {
      const update = builder.update.bind(builder);
      builder.update = (patch: Row) => {
        const kept = fake.rows("rebaselines").find((r) => r.id === RB)?.baseline_before;
        return update(kept && "baseline_before" in patch ? { ...patch, baseline_before: kept } : patch);
      };
    }
    return builder as never;
  };
}

/** Fail the FIRST status flip to `applied` (a transient error after the snapshot already ran). */
function failFirstStatusFlip(fake: FakeDb) {
  const realFrom = fake.client.from;
  let failed = false;
  fake.client.from = (table: string) => {
    const builder = realFrom(table) as unknown as { update: (patch: Row) => unknown };
    if (table === "rebaselines") {
      const update = builder.update.bind(builder);
      builder.update = (patch: Row) => {
        if (patch.status === "applied" && !failed) {
          failed = true;
          const result = { data: null, error: { code: "XX000", message: "connection reset" } };
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
        return update(patch);
      };
    }
    return builder as never;
  };
}

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
    audit_log: [],
    notifications: [],
  });
  db.rpcHandlers.nopm_apply_rebaseline_snapshot = snapshot;
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("apply keeps the real previous baseline across a transient failure", () => {
  it("the before is stored on the rebaseline BEFORE the snapshot RPC runs", async () => {
    simulateWriteOnce(db);
    let storedAtRpc: unknown;
    db.rpcHandlers.nopm_apply_rebaseline_snapshot = (args, fake) => {
      storedAtRpc = fake.rows("rebaselines").find((r) => r.id === RB)?.baseline_before;
      return snapshot(args, fake);
    };
    const res = await call();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(storedAtRpc).toEqual(OLD);
  });

  it("a failure after the RPC, then a retry: the audit still shows the ORIGINAL baseline as before (not before == after)", async () => {
    simulateWriteOnce(db);
    failFirstStatusFlip(db);

    const first = await call();
    expect(first.status).toBe(500);
    // The snapshot already moved the baseline, the rebaseline is still approved, nothing audited.
    expect(project()).toMatchObject({ baseline_start_date: "2027-03-01", baseline_target_date: "2027-10-31" });
    expect(rebaseline().status).toBe("approved");
    expect(applyAudits()).toHaveLength(0);

    const retry = await call();
    expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(200);
    expect(applyAudits()).toHaveLength(1);
    expect(trail()).toEqual({
      before: OLD,
      after: { start: "2027-03-01", target: "2027-10-31" },
    });
  });

  it("a racing second capture cannot replace the stored before with the moved baseline", async () => {
    simulateWriteOnce(db);
    // A first attempt already stored the real before and moved the baseline.
    rebaseline().baseline_before = OLD;
    project().baseline_start_date = "2027-03-01";
    project().baseline_target_date = "2027-10-31";
    await call();
    expect(trail().before).toEqual(OLD);
    expect(rebaseline().baseline_before).toEqual(OLD);
  });

  it("the stored baseline_before is bookkeeping: not in the response or the audit rebaseline shape", async () => {
    simulateWriteOnce(db);
    const json = await (await call()).json();
    expect(json.data).toMatchObject({ id: RB, status: "applied" });
    expect(json.data).not.toHaveProperty("baseline_before");
    const audit = applyAudits()[0];
    expect(audit.before).not.toHaveProperty("baseline_before");
    expect(audit.after).not.toHaveProperty("baseline_before");
  });

  it("a database without migration 0057 still applies, falling back to the in-memory read", async () => {
    const realFrom = db.client.from;
    db.client.from = (table: string) => {
      const builder = realFrom(table) as unknown as { update: (patch: Row) => unknown };
      if (table === "rebaselines") {
        const update = builder.update.bind(builder);
        builder.update = (patch: Row) => {
          if ("baseline_before" in patch) {
            const result = { data: null, error: { code: "42703", message: "column baseline_before does not exist" } };
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
          return update(patch);
        };
      }
      return builder as never;
    };
    const res = await call();
    expect(res.status).toBe(200);
    expect(trail().before).toEqual(OLD);
  });

  it("a project-less rebaseline stores nothing and still applies", async () => {
    rebaseline().project_id = null;
    const res = await call();
    expect(res.status).toBe(200);
    expect(rebaseline().baseline_before).toBeUndefined();
    expect(db.rpcCallsTo("nopm_apply_rebaseline_snapshot")).toHaveLength(0);
  });
});
