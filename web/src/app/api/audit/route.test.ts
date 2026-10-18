import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { FakeDb, OTHER_WS, WS, ids } from "@/lib/integrations/test-support";
import { GET } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const actor = { type: "user", id: ids.admin, label: "Ada", workspaceId: WS, role: "admin", principalId: ids.admin } as Actor;
const get = (qs: string) => GET(new NextRequest(`http://localhost:3000/api/audit?${qs}`), NO_PARAMS);
const row = (id: string, over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  workspace_id: WS,
  actor_type: "user",
  actor_id: ids.admin,
  actor_label: "Ada",
  principal_id: ids.admin,
  action: "task.update",
  target_type: "task",
  target_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  after: { project_id: P1 },
  created_at: "2026-10-19T02:00:00.000Z",
  ...over,
});

let db: FakeDb;
beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor);
  db = new FakeDb();
  state.db = db;
  db.seed("audit_log", [
    row("1", {}),
    row("2", { target_type: "risk", action: "risk.create", after: { project_id: P2 }, created_at: "2026-10-18T02:00:00.000Z" }),
    row("3", { target_type: "workspace", action: "nudge.sent", after: null, created_at: "2026-10-17T02:00:00.000Z" }),
    row("4", { workspace_id: OTHER_WS, after: { project_id: P1 } }),
  ]);
});

describe("GET /api/audit cross-project filters (R-143)", () => {
  it("is unchanged without the new params", async () => {
    const res = await get("");
    expect((await res.json()).data).toHaveLength(3);
  });
  it("filters by project, kinds and the exclusive until bound, never leaking another workspace", async () => {
    expect((await (await get(`project_id=${P1}`)).json()).data.map((r: { id: string }) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect((await (await get("kinds=risk,issue")).json()).data).toHaveLength(1);
    expect((await (await get("until=2026-10-19T00:00:00.000Z")).json()).data).toHaveLength(2);
  });
  it("matches a person's own actions and actions through their token", async () => {
    db.seed("audit_log", [row("5", { actor_type: "token", actor_id: "tok", actor_label: "agent", principal_id: ids.manager })]);
    expect((await (await get(`person_id=${ids.manager}`)).json()).data).toHaveLength(1);
  });
  it("answers 422 to a malformed project, person, kind or until", async () => {
    for (const qs of ["project_id=nope", "person_id=nope", "kinds=task,bogus", "until=yesterday"]) {
      expect((await get(qs)).status, qs).toBe(422);
    }
  });
});
