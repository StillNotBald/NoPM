/**
 * POST /api/projects/:id/rebaselines — D4: a second proposal while one already
 * waits for sign-off (unique index uniq_pending_rebaseline) is a 409 conflict
 * with a clear message, not a 500.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

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
  db = new FakeDb({
    projects: [{ id: PROJECT, workspace_id: WS, name: "Billing", is_locked: true }],
    rebaselines: [],
    audit_log: [],
  });
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
    const realFrom = db.client.from;
    db.client.from = (table: string) => {
      const b = realFrom(table) as unknown as { insert: (r: unknown) => unknown };
      if (table === "rebaselines") {
        b.insert = () => {
          const result = {
            data: null,
            error: { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` },
          };
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
        };
      }
      return b as never;
    };
    return call({ reason: "again" });
  }

  it("the pending index violation (23505) is 409 pending_rebaseline_exists, nothing audited", async () => {
    const res = await collide("uniq_pending_rebaseline");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "This project already has a rebaseline waiting for sign-off",
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
