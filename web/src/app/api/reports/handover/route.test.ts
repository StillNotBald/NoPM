/**
 * GET /api/reports/handover (M6, R-140): single-owner-no-backup per project, the
 * key-person matrix, workspace isolation, scopes, and the audited CSV.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/integrations/time-zone", () => ({ workspaceToday: async () => "2026-10-18" }));
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

import { GET } from "./route";

const W1 = "ws-1";
const W2 = "ws-2";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "22222222-2222-4222-8222-222222222223";
const FOREIGN = "22222222-2222-4222-8222-222222222229";
const P1 = "44444444-4444-4444-8444-444444444441";
const P2 = "44444444-4444-4444-8444-444444444442";
const PF = "44444444-4444-4444-8444-444444444449";
const M_CAROL = "55555555-5555-4555-8555-555555555551";
const M_ALICE = "55555555-5555-4555-8555-555555555552";

let db: FakeDb;

function seed() {
  return new FakeDb({
    profiles: [
      { id: ALICE, workspace_id: W1, display_name: "Alice", email: "a@example.test" },
      { id: BOB, workspace_id: W1, display_name: "Bob", email: "b@example.test" },
      { id: FOREIGN, workspace_id: W2, display_name: "Mallory", email: "m@example.test" },
    ],
    // Alice also exists as a resource member bridged to her login; Carol has no login.
    resource_members: [
      { id: M_CAROL, workspace_id: W1, name: "Carol", profile_id: null },
      { id: M_ALICE, workspace_id: W1, name: "Alice (resource)", profile_id: ALICE },
    ],
    projects: [
      { id: P1, workspace_id: W1, code: "BIL", name: "Billing", owner_id: ALICE, backup_owner_id: BOB, rag_status: "green" },
      { id: P2, workspace_id: W1, code: "OPS", name: "Ops", owner_id: ALICE, backup_owner_id: null, rag_status: "amber" },
      { id: PF, workspace_id: W2, code: "FOR", name: "Foreign", owner_id: FOREIGN, backup_owner_id: null, rag_status: "green" },
    ],
    risks: [
      { id: "r1", workspace_id: W1, project_id: P1, reference_id: "R-001", title: "Slip", status: "open", owner_id: ALICE, backup_owner_id: null },
      { id: "r2", workspace_id: W1, project_id: P1, reference_id: "R-002", title: "Closed one", status: "closed", owner_id: ALICE, backup_owner_id: null },
      { id: "r3", workspace_id: W1, project_id: P1, reference_id: "R-003", title: "Covered", status: "open", owner_id: BOB, backup_owner_id: ALICE },
      { id: "rf", workspace_id: W2, project_id: PF, reference_id: "R-001", title: "Foreign risk", status: "open", owner_id: FOREIGN, backup_owner_id: null },
    ],
    issues: [
      { id: "i1", workspace_id: W1, project_id: P2, reference_id: "ISS-001", title: "Nobody owns this", status: "open", owner_id: null, backup_owner_id: null },
      { id: "i2", workspace_id: W1, project_id: P2, reference_id: "ISS-002", title: "Resolved", status: "resolved", owner_id: BOB, backup_owner_id: null },
    ],
    tasks: [
      // Carol (no login) solely owns a task; Alice solely owns one through her resource-member row.
      { id: "t1", workspace_id: W1, project_id: P1, name: "Migrate data", status: "Started", status_type: "started", assignee_id: M_CAROL, backup_assignee_id: null },
      { id: "t2", workspace_id: W1, project_id: P1, name: "Write cutover plan", status: "Backlog", status_type: "backlog", assignee_id: M_ALICE, backup_assignee_id: null },
      { id: "t3", workspace_id: W1, project_id: P1, name: "Done", status: "Done", status_type: "completed", assignee_id: M_CAROL, backup_assignee_id: null },
      { id: "t4", workspace_id: W1, project_id: P1, name: "Backed up", status: "Started", status_type: "started", assignee_id: M_CAROL, backup_assignee_id: M_ALICE },
    ],
  });
}

const user = (workspaceId = W1): Actor => ({
  type: "user", id: ALICE, label: "Alice", workspaceId, role: "member", principalId: ALICE, channel: "ui", requestId: "r",
});
const token = (scopes: string[]): Actor => ({
  type: "token", id: "tok", label: "agent", workspaceId: W1, scopes, principalId: ALICE, channel: "api", requestId: "r",
});

const get = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/reports/handover${qs}`), { params: Promise.resolve({}) });

beforeEach(() => {
  db = seed();
  holder.db = db;
  authHolder.actor = user();
});

describe("GET /api/reports/handover", () => {
  it("lists open items with a single owner and no backup, per project, grouped by owner", async () => {
    const res = await get();
    expect(res.status, await res.clone().text()).toBe(200);
    const { data } = await res.json();
    const billing = data.projects.find((p: { project: { code: string } }) => p.project.code === "BIL");
    // Open: project (has backup), R-001 (no backup), R-003 (backed up), tasks t1 t2 (no backup), t4 (backed up).
    expect(billing.open_items).toBe(6);
    expect(billing.without_backup).toBe(3);
    const owners = Object.fromEntries(billing.owners.map((o: { person: { label: string }; counts: { total: number } }) => [o.person.label, o.counts.total]));
    // Alice: R-001 + t2 (her resource row is the same person). Carol: t1.
    expect(owners).toEqual({ Alice: 2, Carol: 1 });
    // Closed and completed work is never listed.
    const titles = billing.owners.flatMap((o: { items: { title: string }[] }) => o.items.map((i) => i.title));
    expect(titles).not.toContain("Closed one");
    expect(titles).not.toContain("Done");
    expect(titles).not.toContain("Covered");
    expect(titles).not.toContain("Backed up");
  });

  it("lists the project itself and unowned items separately", async () => {
    const { data } = await (await get()).json();
    const ops = data.projects.find((p: { project: { code: string } }) => p.project.code === "OPS");
    expect(ops.owners[0].person.label).toBe("Alice");
    expect(ops.owners[0].items[0].type).toBe("project");
    expect(ops.unowned).toBe(1);
    expect(ops.unowned_items[0].title).toBe("Nobody owns this");
  });

  it("flags a person with sole ownership in the key-person matrix", async () => {
    const { data } = await (await get()).json();
    const byName = Object.fromEntries(data.key_people.map((k: { person: { label: string } }) => [k.person.label, k]));
    // Alice: R-001, t2 (Billing) + the Ops project = 3 solely owned, across 2 projects.
    expect(byName.Alice.sole_items).toBe(3);
    expect(byName.Alice.projects_touched).toBe(2);
    expect(byName.Alice.bus_factor_1).toBe(true);
    expect(byName.Carol.sole_items).toBe(1);
    expect(byName.Carol.bus_factor_1).toBe(true);
    // Bob only owns covered work and is a backup for others.
    expect(byName.Bob.sole_items).toBe(0);
    expect(byName.Bob.bus_factor_1).toBe(false);
    expect(data.summary.people_bus_factor_1).toBe(2);
  });

  it("never reads or returns another workspace", async () => {
    const { data } = await (await get()).json();
    expect(JSON.stringify(data)).not.toContain("Foreign");
    expect(JSON.stringify(data)).not.toContain("Mallory");
    authHolder.actor = user(W2);
    const other = await (await get()).json();
    expect(JSON.stringify(other.data)).not.toContain("Billing");
    expect(other.data.projects.map((p: { project: { code: string } }) => p.project.code)).toEqual(["FOR"]);
  });

  it("project_id narrows the report; a foreign or malformed project is refused", async () => {
    const { data } = await (await get(`?project_id=${P2}`)).json();
    expect(data.projects.map((p: { project: { code: string } }) => p.project.code)).toEqual(["OPS"]);
    expect((await get(`?project_id=${PF}`)).status).toBe(404);
    expect((await get("?project_id=../unlock")).status).toBe(422);
    expect((await get("?format=xml")).status).toBe(422);
  });

  it("needs report:read, not the entity read scopes", async () => {
    authHolder.actor = token(["project:read", "risk:read", "issue:read", "task:read"]);
    expect((await get()).status).toBe(403);
    authHolder.actor = token(["report:read"]);
    expect((await get()).status).toBe(200);
  });

  it("writes no audit row for the JSON read", async () => {
    await get();
    expect(db.rows("audit_log")).toHaveLength(0);
  });
});

describe("GET /api/reports/handover?format=csv", () => {
  it("returns the same data as CSV and audits it as export.csv, entity handover", async () => {
    const res = await get("?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("nopm-handover-2026-10-18.csv");
    const text = (await res.text()).replace(/^﻿/, "");
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe("section,project_code,project_name,item_type,item_reference,item_title,item_status,person,person_id,sole_items,projects_touched,backup_items,bus_factor_1");
    expect(lines.some((l) => l.startsWith("item,BIL,Billing,risk,R-001,Slip,open,Alice"))).toBe(true);
    expect(lines.some((l) => l.startsWith("unowned,OPS,Ops,issue,ISS-001"))).toBe(true);
    expect(lines.some((l) => l.startsWith("person,,,,,,,Alice,") && l.endsWith(",3,2,2,true"))).toBe(true);
    expect(text).not.toContain("Foreign");

    const audits = db.rows("audit_log");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("export.csv");
    expect((audits[0].after as { entity: string }).entity).toBe("handover");
    expect((audits[0].after as { row_count: number }).row_count).toBe(lines.length - 1);
  });
});
