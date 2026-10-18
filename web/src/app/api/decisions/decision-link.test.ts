/**
 * B1 (decision <-> change request link, structured options) and B2 (structured
 * scope impact): the schemas and the decision routes over the in-memory database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { createDecisionSchema, optionsStructuredSchema } from "./_schema";
import { createChangeRequestSchema, impactScopeSchema, updateChangeRequestSchema } from "@/app/api/change-requests/_schema";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: async () => {} }));
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

import { POST as createDecision } from "@/app/api/projects/[id]/decisions/route";
import { PATCH as patchDecision } from "@/app/api/decisions/[id]/route";

const WS = "ws-1";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CR_P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const CR_P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const CR_OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
const DEC = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const BOB = "22222222-2222-4222-8222-222222222222";

const manager: Actor = {
  type: "user",
  id: BOB,
  label: "bob",
  workspaceId: WS,
  role: "manager",
  principalId: BOB,
  channel: "ui",
} as Actor;

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({
    projects: [
      { id: P1, workspace_id: WS, name: "One" },
      { id: P2, workspace_id: WS, name: "Two" },
    ],
    change_requests: [
      { id: CR_P1, workspace_id: WS, project_id: P1, title: "A" },
      { id: CR_P2, workspace_id: WS, project_id: P2, title: "B" },
      { id: CR_OTHER_WS, workspace_id: "ws-2", project_id: P1, title: "C" },
    ],
    decisions: [{ id: DEC, workspace_id: WS, project_id: P1, title: "D", status: "proposed" }],
  });
  holder.db = db;
  authHolder.actor = manager;
});

const create = (projectId: string, body: Record<string, unknown>) =>
  createDecision(
    new NextRequest(`http://localhost/api/projects/${projectId}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
const patch = (body: Record<string, unknown>) =>
  patchDecision(
    new NextRequest(`http://localhost/api/decisions/${DEC}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: DEC }) },
  );

describe("B1 - structured options", () => {
  it("accepts a list with one chosen option and defaults chosen to false", () => {
    const r = optionsStructuredSchema.safeParse([{ label: "Slip a week", chosen: true }, { label: "Cut scope" }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data[1]).toMatchObject({ label: "Cut scope", chosen: false });
  });
  it("refuses two chosen options, duplicate labels, a blank label and more than 20", () => {
    expect(optionsStructuredSchema.safeParse([{ label: "a", chosen: true }, { label: "b", chosen: true }]).success).toBe(false);
    expect(optionsStructuredSchema.safeParse([{ label: "a" }, { label: "A" }]).success).toBe(false);
    expect(optionsStructuredSchema.safeParse([{ label: "  " }]).success).toBe(false);
    expect(optionsStructuredSchema.safeParse(Array.from({ length: 21 }, (_, i) => ({ label: `o${i}` }))).success).toBe(false);
  });
  it("the create schema keeps the free-text options and accepts both", () => {
    const r = createDecisionSchema.safeParse({
      title: "t",
      options: "free text",
      options_structured: [{ label: "x", chosen: true }],
      change_request_id: CR_P1,
    });
    expect(r.success).toBe(true);
  });
});

describe("B1 - decision to change request link (workspace and project checked)", () => {
  it("links a change request of the same project, returns both option forms", async () => {
    const res = await create(P1, {
      title: "Slip the launch",
      options: "free text",
      options_structured: [{ label: "Slip", chosen: true, note: "one week" }, { label: "Cut scope" }],
      change_request_id: CR_P1,
    });
    expect(res.status).toBe(201);
    const row = (await res.json()).data;
    expect(row).toMatchObject({ change_request_id: CR_P1, options: "free text" });
    expect(row.options_structured).toEqual([
      { label: "Slip", chosen: true, note: "one week" },
      { label: "Cut scope", chosen: false },
    ]);
    expect(db.rows("decisions").some((d) => d.change_request_id === CR_P1)).toBe(true);
  });

  it("a change request on another project is 422 invalid_reference", async () => {
    const res = await create(P1, { title: "x", change_request_id: CR_P2 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_reference");
    expect(body.fields[0].field).toBe("change_request_id");
  });

  it("a change request of another workspace is 422, with the same message as a missing one", async () => {
    const foreign = await (await create(P1, { title: "x", change_request_id: CR_OTHER_WS })).json();
    const missing = await (
      await create(P1, { title: "x", change_request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9" })
    ).json();
    expect(foreign.fields[0].message).toBe(missing.fields[0].message);
  });

  it("no link is fine: the field stays null", async () => {
    const res = await create(P1, { title: "plain" });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ change_request_id: null, options_structured: null });
  });

  it("PATCH links within the decision's project and refuses another project's request", async () => {
    const ok = await patch({ change_request_id: CR_P1, options_structured: [{ label: "A", chosen: true }] });
    expect(ok.status).toBe(200);
    expect(db.rows("decisions").find((d) => d.id === DEC)).toMatchObject({ change_request_id: CR_P1 });
    const bad = await patch({ change_request_id: CR_P2 });
    expect([bad.status, (await bad.json()).code]).toEqual([422, "invalid_reference"]);
  });

  it("PATCH refuses a link on a decision that has no project (422)", async () => {
    db.rows("decisions").find((d) => d.id === DEC)!.project_id = null;
    const res = await patch({ change_request_id: CR_P1 });
    expect(res.status).toBe(422);
    expect(db.rows("decisions").find((d) => d.id === DEC)?.change_request_id).toBeUndefined();
  });

  it("PATCH can clear the link with null", async () => {
    await patch({ change_request_id: CR_P1 });
    const res = await patch({ change_request_id: null });
    expect(res.status).toBe(200);
    expect(db.rows("decisions").find((d) => d.id === DEC)?.change_request_id).toBeNull();
  });

  it("a malformed structured list is a 422 validation error", async () => {
    const res = await create(P1, { title: "x", options_structured: [{ label: "a", chosen: true }, { label: "b", chosen: true }] });
    expect(res.status).toBe(422);
  });
});

describe("B2 - structured scope impact on a change request", () => {
  it("accepts one entry per area with a direction and optional note", () => {
    const r = impactScopeSchema.safeParse([
      { area: "scope", direction: "increase", note: "two more screens" },
      { area: "cost", direction: "neutral" },
    ]);
    expect(r.success).toBe(true);
  });
  it("refuses an unknown area or direction, a repeated area, and more than six entries", () => {
    expect(impactScopeSchema.safeParse([{ area: "morale", direction: "increase" }]).success).toBe(false);
    expect(impactScopeSchema.safeParse([{ area: "scope", direction: "up" }]).success).toBe(false);
    expect(impactScopeSchema.safeParse([{ area: "scope", direction: "increase" }, { area: "scope", direction: "decrease" }]).success).toBe(false);
  });
  it("create and edit schemas take impact_scope beside the free-text impact_summary", () => {
    const body = { title: "t", impact_summary: "text stays", impact_scope: [{ area: "schedule", direction: "increase" }] };
    expect(createChangeRequestSchema.safeParse(body).success).toBe(true);
    expect(updateChangeRequestSchema.safeParse({ impact_scope: null }).success).toBe(true);
    expect(updateChangeRequestSchema.safeParse({ impact_scope: [{ area: "x", direction: "increase" }] }).success).toBe(false);
  });
});
