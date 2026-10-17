/**
 * Two-step routes, auth-core fix wave (2026-10-17):
 *  - D-ACC-4  enroll while two-step is ON -> 409, stored factor untouched
 *  - D-ACC-5  disable needs a current TOTP or an unused backup code (422 otherwise, audited)
 *  - D-ACC-19 a TOTP code cannot be replayed inside its 30-second step; attempts are capped (429 + Retry-After)
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { authenticator } from "otplib";
import type { Actor } from "@/lib/auth/guard";
import { fakeDb, type Call } from "@/lib/auth/fake-db.testutil";
import { encrypt } from "@/lib/crypto";
import { hashBackupCode } from "@/lib/auth/mfa-factor";

type MfaRow = {
  totp_secret: string;
  enabled: boolean;
  backup_codes: string[] | null;
  enrolled_at: string;
  last_totp_step: number | null;
};

const { state } = vi.hoisted(() => ({
  state: {
    actor: null as unknown,
    mfa: null as unknown,
    rateAllowed: true,
    db: null as unknown as ReturnType<typeof import("@/lib/auth/fake-db.testutil").fakeDb>,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => state.actor as Actor };
});

import { POST as enroll } from "./enroll/route";
import { POST as verify } from "./verify/route";
import { POST as challenge } from "./challenge/route";
import { POST as disable } from "./disable/route";

const user: Actor = { type: "user", id: "u-1", label: "U", workspaceId: "ws-1", role: "member", principalId: "u-1" };
const SECRET = authenticator.generateSecret();

beforeAll(() => {
  process.env.NOPM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

function mfaRow(over: Partial<MfaRow> = {}): MfaRow {
  return {
    totp_secret: encrypt(SECRET),
    enabled: true,
    backup_codes: [hashBackupCode("b".repeat(32))],
    enrolled_at: "2026-10-01T00:00:00Z",
    last_totp_step: null,
    ...over,
  };
}

function setup(row: MfaRow | null) {
  state.mfa = row;
  state.db = fakeDb(
    (c: Call) => {
      const cur = state.mfa as MfaRow | null;
      if (c.table === "user_mfa" && c.op === "select") return { data: cur };
      if (c.table === "user_mfa" && c.op === "update" && cur) {
        const patch = c.payload as Partial<MfaRow>;
        if ("last_totp_step" in patch && typeof patch.last_totp_step === "number") {
          // emulate: .or("last_totp_step.is.null,last_totp_step.lt.<step>")
          if (cur.last_totp_step !== null && cur.last_totp_step >= patch.last_totp_step) return { data: [] };
        }
        state.mfa = { ...cur, ...patch };
        return { data: [{ user_id: "u-1" }] };
      }
      if (c.table === "user_mfa" && c.op === "upsert") {
        state.mfa = { ...(c.payload as MfaRow) };
        return {};
      }
      if (c.table === "audit_log" && c.op === "select") return { count: 0 };
      return {};
    },
    () =>
      state.rateAllowed
        ? { data: { allowed: true, remaining: 9, retry_after_seconds: 0 } }
        : { data: { allowed: false, remaining: 0, retry_after_seconds: 123 } },
  );
}

const post = (handler: typeof enroll, body?: unknown) =>
  handler(
    new NextRequest("http://localhost/api/auth/mfa/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

const actions = () => state.db.auditRows().map((r) => r.action);

beforeEach(() => {
  state.actor = user;
  state.rateAllowed = true;
});

describe("POST /api/auth/mfa/enroll (D-ACC-4)", () => {
  it("409 'Two-step is already on. Turn it off first.' and the stored factor is untouched", async () => {
    setup(mfaRow());
    const before = JSON.stringify(state.mfa);
    const res = await post(enroll);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Two-step is already on. Turn it off first.");
    expect(JSON.stringify(state.mfa)).toBe(before);
    expect(state.db.calls.some((c) => c.op === "upsert")).toBe(false);
    expect(actions()).toHaveLength(0);
  });

  it("enrolls normally when two-step is off or never set up", async () => {
    setup(mfaRow({ enabled: false }));
    expect((await post(enroll)).status).toBe(200);
    expect(actions()).toEqual(["mfa.enroll_started"]);
  });
});

describe("POST /api/auth/mfa/disable (D-ACC-5)", () => {
  it("422 with no code, factor untouched", async () => {
    setup(mfaRow());
    const res = await post(disable, {});
    expect(res.status).toBe(422);
    expect((state.mfa as MfaRow).enabled).toBe(true);
    expect(actions()).not.toContain("mfa.disabled");
  });

  it("422 with a wrong code, audited as auth.mfa.disable_failed, factor untouched", async () => {
    setup(mfaRow());
    const res = await post(disable, { code: "000000" });
    expect(res.status).toBe(422);
    expect(actions()).toEqual(["auth.mfa.disable_failed"]);
    expect((state.mfa as MfaRow).enabled).toBe(true);
  });

  it("disables with a current TOTP code (audit mfa.disabled)", async () => {
    setup(mfaRow());
    const res = await post(disable, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(200);
    expect((state.mfa as MfaRow).enabled).toBe(false);
    expect(actions()).toEqual(["mfa.disabled"]);
  });

  it("disables with an unused backup code", async () => {
    setup(mfaRow());
    const res = await post(disable, { code: "b".repeat(32) });
    expect(res.status).toBe(200);
    expect(actions()).toEqual(["mfa.disabled"]);
  });

  it("cancelling an unconfirmed enrollment needs no code", async () => {
    setup(mfaRow({ enabled: false }));
    expect((await post(disable, {})).status).toBe(200);
  });

  it("429 with Retry-After when the attempt budget is spent", async () => {
    setup(mfaRow());
    state.rateAllowed = false;
    const res = await post(disable, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("123");
    expect((state.mfa as MfaRow).enabled).toBe(true);
  });
});

describe("TOTP replay and attempt cap (D-ACC-19)", () => {
  it("challenge: the same valid code works once, the second use inside its step is refused", async () => {
    setup(mfaRow());
    const code = authenticator.generate(SECRET);
    expect((await post(challenge, { code })).status).toBe(200);
    const again = await post(challenge, { code });
    expect(again.status).toBe(422);
    expect(actions()).toContain("auth.mfa.challenge_failed");
  });

  it("verify: a wrong code is 422 and audited; the right code enables once", async () => {
    setup(mfaRow({ enabled: false }));
    const bad = await post(verify, { code: "000000" });
    expect(bad.status).toBe(422);
    expect(actions()).toEqual(["auth.mfa.verify_failed"]);

    const good = await post(verify, { code: authenticator.generate(SECRET) });
    expect(good.status).toBe(200);
    expect((state.mfa as MfaRow).enabled).toBe(true);
  });

  it("verify and challenge return 429 + Retry-After once the account's attempt budget is spent", async () => {
    setup(mfaRow({ enabled: false }));
    state.rateAllowed = false;
    for (const [h, body] of [
      [verify, { code: authenticator.generate(SECRET) }],
      [challenge, { code: authenticator.generate(SECRET) }],
    ] as const) {
      const res = await post(h, body);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("123");
    }
  });
});
