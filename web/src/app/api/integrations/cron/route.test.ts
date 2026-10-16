import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { requireAuthMock, runCronMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn(), runCronMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("@/lib/integrations/cron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/cron")>()),
  runCron: runCronMock,
}));

import { GET } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const call = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/integrations/cron", { headers }), NO_PARAMS);

const SUMMARY = {
  connectors: 1,
  deliveries: { claimed: 2, sent: 2, retried: 0, dead: 0, superseded: 0, deferred: 0 },
  digests: { sent: 0, skipped: 1, failed: 0 },
};

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-value-0001");
  requireAuthMock.mockReset();
  runCronMock.mockReset();
  runCronMock.mockResolvedValue(SUMMARY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/integrations/cron", () => {
  it("runs the tick for the correct Bearer CRON_SECRET and returns the summary — no session needed", async () => {
    const res = await call({ authorization: "Bearer cron-secret-value-0001" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: SUMMARY });
    expect(runCronMock).toHaveBeenCalledTimes(1);
    expect(requireAuthMock).not.toHaveBeenCalled(); // auth:false route
  });

  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }],
    ["a session-style header", { authorization: "Bearer npm_some_user_token" }],
    ["no Bearer scheme", { authorization: "cron-secret-value-0001" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("rejects %s with 401 and runs nothing", async (_label, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(401);
    expect(runCronMock).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset: not even a bearer matching 'undefined' or '' gets in", async () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const authorization of ["Bearer undefined", "Bearer ", "Bearer", "Bearer cron-secret-value-0001"]) {
      expect((await call({ authorization })).status).toBe(401);
    }
    expect(runCronMock).not.toHaveBeenCalled();
  });

  it("surfaces an internal failure as a sanitised 500, not a stack trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runCronMock.mockRejectedValueOnce(new Error("connection string postgres://user:pw@host/db"));
    vi.stubEnv("NODE_ENV", "production");
    const res = await call({ authorization: "Bearer cron-secret-value-0001" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("postgres://");
  });
});

describe("vercel.json cron entry", () => {
  it("calls this route daily, off the hour and half-hour (Lark sheds load at :00/:30)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };
    const entry = config.crons?.find((c) => c.path === "/api/integrations/cron");
    expect(entry).toBeDefined();
    const [minute, hour, dom, month, dow] = (entry as { schedule: string }).schedule.split(/\s+/);
    expect(/^\d+$/.test(minute) && /^\d+$/.test(hour)).toBe(true); // once a day
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);
    expect(["0", "30"]).not.toContain(minute);
  });
});
