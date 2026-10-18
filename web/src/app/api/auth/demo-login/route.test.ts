/**
 * POST /api/auth/demo-login — the landing page's one conversion path.
 *
 * The A5 audit found the failure path a dead end: a rejected sign-in redirected
 * to /login?error=demo_unavailable which the form ignored, and a missing demo
 * config returned raw JSON to a browser navigation (a blank page of braces).
 * These tests pin the contract: a browser never receives JSON on failure, every
 * failure lands on a code the login page explains, and the documented
 * programmatic contract (JSON 503, 302 on a rejected sign-in) is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { demoLoginErrorMessage } from "@/app/login/login-errors";

const signInWithPassword = vi.fn();
const createServerClient = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (...args: unknown[]) => createServerClient(...args),
}));

import { POST } from "./route";

const BROWSER = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const PROGRAMMATIC = { accept: "application/json" };

function post(headers: Record<string, string> = BROWSER) {
  return POST(new Request("https://nopm.example.test/api/auth/demo-login", { method: "POST", headers }));
}

beforeEach(() => {
  signInWithPassword.mockReset();
  createServerClient.mockReset();
  createServerClient.mockImplementation(() => ({ auth: { signInWithPassword } }));
  vi.stubEnv("DEMO_EMAIL", "demo@example.test");
  vi.stubEnv("DEMO_PASSWORD", "not-a-real-password");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.example.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function location(res: Response): string | null {
  return res.headers.get("location");
}

describe("demo-login — not configured", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_EMAIL", "");
    vi.stubEnv("DEMO_PASSWORD", "");
  });

  it("a browser navigation is redirected to /login?error=demo_unconfigured, never shown JSON", async () => {
    const res = await post(BROWSER);
    expect(res.status).toBe(302);
    expect(location(res)).toBe("https://nopm.example.test/login?error=demo_unconfigured");
    expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
  });

  it("a programmatic caller keeps the documented JSON 503", async () => {
    const res = await post(PROGRAMMATIC);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Demo account is not configured on this deployment." });
  });

  it("a caller with no Accept header is programmatic too (curl / agents)", async () => {
    const res = await post({});
    expect(res.status).toBe(503);
  });

  it("never reaches Supabase when there are no credentials", async () => {
    await post(BROWSER);
    expect(createServerClient).not.toHaveBeenCalled();
  });
});

describe("demo-login — sign-in fails", () => {
  it("a rejected sign-in redirects to /login?error=demo_unavailable (browser)", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const res = await post(BROWSER);
    expect(res.status).toBe(302);
    expect(location(res)).toBe("https://nopm.example.test/login?error=demo_unavailable");
  });

  it("the documented 302 holds for programmatic callers as well", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "nope" } });
    const res = await post(PROGRAMMATIC);
    expect(res.status).toBe(302);
    expect(location(res)).toContain("/login?error=demo_unavailable");
  });

  it("a thrown error while signing in is the same visitor-facing outcome, not a 500 page", async () => {
    signInWithPassword.mockRejectedValue(new Error("fetch failed"));
    const res = await post(BROWSER);
    expect(res.status).toBe(302);
    expect(location(res)).toContain("/login?error=demo_unavailable");
  });

  it("a thrown error while building the client (bad env) is handled the same way", async () => {
    createServerClient.mockImplementation(() => {
      throw new Error("Invalid supabaseUrl");
    });
    const res = await post(BROWSER);
    expect(res.status).toBe(302);
    expect(location(res)).toContain("/login?error=demo_unavailable");
  });

  it("does not leak the failure detail into the redirect", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "secret detail from the auth host" } });
    const res = await post(BROWSER);
    expect(location(res)).not.toContain("secret");
  });
});

describe("demo-login — success", () => {
  it("redirects to /dashboard and carries the session cookies Supabase sets", async () => {
    createServerClient.mockImplementation(
      (_url: string, _key: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => ({
        auth: {
          signInWithPassword: async () => {
            opts.cookies.setAll([{ name: "sb-access-token", value: "token-value", options: { path: "/" } }]);
            return { error: null };
          },
        },
      }),
    );
    const res = await post(BROWSER);
    expect(res.status).toBe(302);
    expect(location(res)).toBe("https://nopm.example.test/dashboard");
    expect(res.headers.get("set-cookie")).toContain("sb-access-token=token-value");
  });
});

describe("every code the route can emit has a message on the login page", () => {
  it.each(["demo_unavailable", "demo_unconfigured"])("%s", (code) => {
    expect(demoLoginErrorMessage(code)).toEqual(expect.any(String));
  });
});
