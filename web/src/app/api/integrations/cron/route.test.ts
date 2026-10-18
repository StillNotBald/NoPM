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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_DEADLINE_MS, CRON_GRACE_MS } from "@/lib/integrations/cron";
import { LARK_CALL_TIMEOUT_MS } from "@/lib/integrations/lark/client";
import { GET } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const call = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/integrations/cron", { headers }), NO_PARAMS);

const SUMMARY = {
  connectors: 1,
  deliveries: { claimed: 2, sent: 2, retried: 0, dead: 0, superseded: 0, deferred: 0, deadlineSkipped: 0 },
  digests: { sent: 0, skipped: 1, queued: 0, failed: 0 },
  skippedForDeadline: 0,
  timedOut: 0,
  pruned: { deliveries: 0, action_tokens: 0, inbound_actions: 0 },
  elapsedMs: 12,
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

describe("time budget", () => {
  // Next reads `maxDuration` statically, so the route holds a literal. The tick's own
  // limits live in lib/integrations/cron.ts; these tests keep the two in step.
  const source = readFileSync(join(__dirname, "route.ts"), "utf8");
  const maxDurationMs = Number(/export const maxDuration = (\d+);/.exec(source)?.[1]) * 1000;

  it("declares maxDuration explicitly as a number literal (Next route segment config)", () => {
    expect(Number.isInteger(maxDurationMs) && maxDurationMs > 0).toBe(true);
  });

  it("stops starting work, then still has room for one platform call, before the platform kills the function", () => {
    expect(CRON_DEADLINE_MS + LARK_CALL_TIMEOUT_MS).toBeLessThan(maxDurationMs);
    // ...and an overrunning connector job is abandoned before the limit as well
    expect(CRON_DEADLINE_MS + CRON_GRACE_MS).toBeLessThan(maxDurationMs);
  });
});

describe("operator signals", () => {
  beforeEach(() => vi.restoreAllMocks()); // a fresh console spy per test: no calls carried over from earlier tests
  afterEach(() => vi.restoreAllMocks());
  it("says so in the log when CRON_SECRET is unset or blank (otherwise it looks like a cron that never fires)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", "  \n");
    expect((await call({ authorization: "Bearer anything" })).status).toBe(401);
    expect(log.mock.calls.flat().join(" ")).toMatch(/CRON_SECRET is not set/);
  });

  it("does not cry wolf for a wrong credential when the secret IS configured", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/CRON_SECRET/);
  });

  it("accepts the secret even when the env value carries a trailing newline", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret-value-0001\n");
    expect((await call({ authorization: "Bearer cron-secret-value-0001" })).status).toBe(200);
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

  it("is the schedule the route documents, not the older 0 1 * * * it used to claim", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };
    const schedule = config.crons?.find((c) => c.path === "/api/integrations/cron")?.schedule;
    const doc = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(doc).toContain(`\`${schedule}\``);
    expect(doc).not.toContain("0 1 * * *");
  });
});
