/**
 * GET /api/health — liveness stays public and DB-free, and now names the
 * deployed build (audit L-02). The env contract is read-at-request-time, so
 * each test sets it with vi.stubEnv.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readBuildInfo } from "./_build";

// route() imports the auth guard and admin client at module scope; neither is
// ever called for this auth:false route, but stub them so a missing env can't
// matter and the test fails loudly if health ever starts touching the DB.
const adminSpy = vi.fn();
vi.mock("@/lib/auth/guard", () => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: (...a: unknown[]) => adminSpy(...a) }));

import { GET } from "./route";

const call = () => GET(new NextRequest("http://localhost/api/health"), { params: Promise.resolve({}) });

afterEach(() => {
  vi.unstubAllEnvs();
  adminSpy.mockClear();
});

describe("readBuildInfo", () => {
  it("reads the Vercel commit sha and ref", () => {
    expect(readBuildInfo({ VERCEL_GIT_COMMIT_SHA: "abc123", VERCEL_GIT_COMMIT_REF: "main" })).toEqual({
      sha: "abc123",
      ref: "main",
    });
  });

  it("falls back to NEXT_PUBLIC_BUILD_SHA for self-hosted builds (ref stays null)", () => {
    expect(readBuildInfo({ NEXT_PUBLIC_BUILD_SHA: "def456" })).toEqual({ sha: "def456", ref: null });
  });

  it("prefers the Vercel sha when both are set", () => {
    expect(readBuildInfo({ VERCEL_GIT_COMMIT_SHA: "v1", NEXT_PUBLIC_BUILD_SHA: "n1" }).sha).toBe("v1");
  });

  it("is null for absent, empty or whitespace-only values", () => {
    expect(readBuildInfo({})).toEqual({ sha: null, ref: null });
    expect(readBuildInfo({ VERCEL_GIT_COMMIT_SHA: "", NEXT_PUBLIC_BUILD_SHA: "  ", VERCEL_GIT_COMMIT_REF: " " })).toEqual({
      sha: null,
      ref: null,
    });
  });
});

describe("GET /api/health", () => {
  it("keeps the liveness contract and adds build", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
    const res = await call();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      status: "ok",
      service: "nopm",
      build: { sha: "0123456789abcdef", ref: "main" },
    });
    expect(Number.isNaN(Date.parse(data.time))).toBe(false);
  });

  it("reports build nulls (not an error) when the host exposes no commit", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    const { data } = await (await call()).json();
    expect(data.build).toEqual({ sha: null, ref: null });
  });

  it("never touches the database", async () => {
    await call();
    expect(adminSpy).not.toHaveBeenCalled();
  });
});
