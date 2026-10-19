import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { OTHER_WS, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { WeeklyReportFakeDb } from "@/lib/nudges/weekly-report-test-support";
import { generateWeeklyReport } from "@/lib/nudges/weekly-report";
import { GET, POST } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const NOW = new Date("2026-10-20T01:00:00.000Z"); // Tuesday of the week starting 2026-10-19

const user = (role: string): Actor => ({ type: "user", id: ids.admin, label: "Ada", workspaceId: WS, role, principalId: ids.admin }) as Actor;
const token = (scopes: string[], workspaceId = WS): Actor =>
  ({ type: "token", id: "tok-1", label: "agent", workspaceId, scopes, principalId: ids.admin, principalRole: "admin" }) as Actor;
const get = (qs = "") => GET(new NextRequest(`http://localhost:3000/api/reports/weekly${qs}`), NO_PARAMS);
const post = () => POST(new NextRequest("http://localhost:3000/api/reports/weekly", { method: "POST", body: "{}" }), NO_PARAMS);

let db: WeeklyReportFakeDb;
beforeEach(async () => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(user("admin"));
  db = new WeeklyReportFakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("workspaces", [{ id: OTHER_WS, name: "Other" }]);
  db.seed("projects", [
    { id: "p1", workspace_id: WS, code: "APO", name: "Apollo", owner_id: ids.manager, rag_status: "red", is_locked: false },
    { id: "p2", workspace_id: WS, code: "ZEN", name: "Zenith", owner_id: ids.manager, rag_status: "green", is_locked: false },
    { id: "px", workspace_id: OTHER_WS, code: "FOR", name: "Foreign", owner_id: null, rag_status: "green", is_locked: false },
  ]);
  await generateWeeklyReport(WS, { now: NOW, trigger: "manual", actor: user("admin") });
  db.audits.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/reports/weekly", () => {
  it("returns the HTML for the week with the project codes", async () => {
    const res = await get("?week=2026-10-19");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("APO");
    expect(html).toContain("ZEN");
    expect(html).not.toContain("FOR"); // another workspace's project
    expect(html).toContain("Apollo");
  });

  it("accepts any day of the week and an ISO week, and defaults to the current week", async () => {
    expect((await get("?week=2026-10-23")).status).toBe(200);
    expect((await get("?week=2026-W43")).status).toBe(200);
    expect((await get()).status).toBe(200);
  });

  it("is 403 for a token without the report:read scope", async () => {
    requireAuthMock.mockResolvedValue(token(["project:read", "audit:read"]));
    const res = await get("?week=2026-10-19");
    expect(res.status).toBe(403);
  });

  it("serves a token that has the scope, and a report:* wildcard", async () => {
    requireAuthMock.mockResolvedValue(token(["report:read"]));
    expect((await get("?week=2026-10-19")).status).toBe(200);
    requireAuthMock.mockResolvedValue(token(["report:*"]));
    expect((await get("?week=2026-10-19")).status).toBe(200);
  });

  it("never serves another workspace's report", async () => {
    requireAuthMock.mockResolvedValue(token(["report:read"], OTHER_WS));
    expect((await get("?week=2026-10-19")).status).toBe(404);
  });

  it("is 404 when no report exists for that week and 422 for an unreadable week", async () => {
    expect((await get("?week=2026-09-01")).status).toBe(404);
    expect((await get("?week=yesterday")).status).toBe(422);
  });

  it("shows what was generated, not the live figures", async () => {
    db.rows("projects").find((p) => p.id === "p1")!.name = "Renamed later";
    const html = await (await get("?week=2026-10-19")).text();
    expect(html).toContain("Apollo");
    expect(html).not.toContain("Renamed later");
  });
});

describe("POST /api/reports/weekly (send now)", () => {
  it("lets an admin or manager send it, with one audit row", async () => {
    for (const role of ["admin", "manager"]) {
      db.audits.length = 0;
      requireAuthMock.mockResolvedValue(user(role));
      const res = await post();
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ week_start: "2026-10-19", report_url: "/api/reports/weekly?week=2026-10-19" });
      expect(db.audits).toHaveLength(1);
      expect(db.audits[0]).toMatchObject({ action: "report.weekly.generated", after: { trigger: "manual" } });
    }
  });

  it("refuses members, viewers and tokens", async () => {
    for (const actor of [user("member"), user("viewer"), token(["report:read", "report:write"])]) {
      requireAuthMock.mockResolvedValue(actor);
      expect((await post()).status).toBe(403);
    }
    expect(db.audits).toHaveLength(0);
  });
});
