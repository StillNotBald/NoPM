import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { requireAuthMock, takeSnapshotsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  takeSnapshotsMock: vi.fn(),
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("@/lib/insight/snapshots", () => ({ takeSnapshots: takeSnapshotsMock }));

import { GET } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const call = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/cron/snapshots", { headers }), NO_PARAMS);

const SUMMARY = { workspaces: 1, projects: 3, taken: 3, skipped: 0 };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret-value-0001");
  requireAuthMock.mockReset();
  takeSnapshotsMock.mockReset();
  takeSnapshotsMock.mockResolvedValue(SUMMARY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/cron/snapshots", () => {
  it("takes the snapshots for the correct Bearer CRON_SECRET, with no session", async () => {
    const res = await call({ authorization: "Bearer cron-secret-value-0001" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: SUMMARY });
    expect(takeSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(requireAuthMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", {}],
    ["a wrong secret", { authorization: "Bearer not-the-secret" }],
    ["no Bearer scheme", { authorization: "cron-secret-value-0001" }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("rejects %s with 401 and takes nothing", async (_label, headers) => {
    const res = await call(headers);
    expect(res.status).toBe(401);
    expect(takeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", "");
    for (const authorization of ["Bearer undefined", "Bearer ", "Bearer cron-secret-value-0001"]) {
      expect((await call({ authorization })).status).toBe(401);
    }
    expect(takeSnapshotsMock).not.toHaveBeenCalled();
  });
});
