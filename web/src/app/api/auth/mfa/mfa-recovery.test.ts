/**
 * Fix wave F1 (2026-10-17):
 *  - R-4  a challenge passed in the last 10 minutes lets the user turn two-step off / re-enrol without another code
 *  - R-5  the shared demo login cannot enrol, verify or disable two-step (403 demo_restricted)
 *  - R-8  challenge / enroll / disable still work when migration 0060 (user_mfa.last_totp_step) is not applied
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { authenticator } from "otplib";
import type { Actor } from "@/lib/auth/guard";
import { fakeDb, type Call } from "@/lib/auth/fake-db.testutil";
import { encrypt } from "@/lib/crypto";
import { computeEnrollmentBinding, issueMfaCookie } from "@/lib/auth/mfa";

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
    cookie: undefined as string | undefined,
    demo: false,
    noStepColumn: false,
    db: null as unknown as ReturnType<typeof import("@/lib/auth/fake-db.testutil").fakeDb>,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "nopm_mfa" && state.cookie ? { value: state.cookie } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("@/lib/auth/demo", () => ({
  DEMO_RESTRICTED_MESSAGE: "Not available in the shared demo",
  isDemoActor: async () => state.demo,
}));
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
const ENROLLED_AT = "2026-10-01T00:00:00Z";

beforeAll(() => {
  process.env.NOPM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

const row = (over: Partial<MfaRow> = {}): MfaRow => ({
  totp_secret: encrypt(SECRET),
  enabled: true,
  backup_codes: [],
  enrolled_at: ENROLLED_AT,
  last_totp_step: null,
  ...over,
});

function setup(r: MfaRow | null) {
  state.mfa = r;
  state.db = fakeDb(
    (c: Call) => {
      const cur = state.mfa as MfaRow | null;
      const payload = (c.payload ?? {}) as Record<string, unknown>;
      if (state.noStepColumn && "last_totp_step" in payload && (c.op === "update" || c.op === "upsert")) {
        return { error: { message: "column user_mfa.last_totp_step does not exist", code: "42703" } };
      }
      if (c.table === "user_mfa" && c.op === "select") return { data: cur };
      if (c.table === "user_mfa" && c.op === "update" && cur) {
        state.mfa = { ...cur, ...(payload as Partial<MfaRow>) };
        return { data: [{ user_id: "u-1" }] };
      }
      if (c.table === "user_mfa" && c.op === "upsert") {
        state.mfa = { ...(payload as MfaRow) };
        return {};
      }
      if (c.table === "audit_log" && c.op === "select") return { count: 0 };
      return {};
    },
    () => ({ data: { allowed: true, remaining: 9, retry_after_seconds: 0 } }),
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
const freshCookie = () => issueMfaCookie("u-1", computeEnrollmentBinding(ENROLLED_AT)).value;

beforeEach(() => {
  vi.useRealTimers();
  state.actor = user;
  state.cookie = undefined;
  state.demo = false;
  state.noStepColumn = false;
});

describe("R-4 recent challenge as step-up", () => {
  it("disable needs no code when the MFA cookie was issued within 10 minutes", async () => {
    setup(row());
    state.cookie = freshCookie();
    const res = await post(disable, {});
    expect(res.status).toBe(200);
    expect((state.mfa as MfaRow).enabled).toBe(false);
    expect(actions()).toEqual(["mfa.disabled"]);
    expect(state.db.auditRows()[0].after).toMatchObject({ via: "recent_challenge" });
  });

  it("disable still needs a code once the challenge is older than 10 minutes", async () => {
    setup(row());
    state.cookie = freshCookie();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const res = await post(disable, {});
    expect(res.status).toBe(422);
    expect((state.mfa as MfaRow).enabled).toBe(true);
  });

  it("a cookie bound to a different enrolment is not a recent challenge", async () => {
    setup(row({ enrolled_at: "2026-10-02T00:00:00Z" }));
    state.cookie = freshCookie();
    expect((await post(disable, {})).status).toBe(422);
  });

  it("enroll over a live factor is allowed with a recent challenge (re-enrol on a new phone)", async () => {
    setup(row());
    state.cookie = freshCookie();
    const res = await post(enroll);
    expect(res.status).toBe(200);
    expect((state.mfa as MfaRow).enabled).toBe(false);
    expect(actions()).toEqual(["mfa.enroll_started"]);
  });

  it("enroll over a live factor is still 409 without a recent challenge", async () => {
    setup(row());
    expect((await post(enroll)).status).toBe(409);
  });
});

describe("R-5 shared demo login", () => {
  it.each([
    ["enroll", enroll, undefined],
    ["verify", verify, { code: "123456" }],
    ["disable", disable, { code: "123456" }],
  ] as const)("%s is 403 demo_restricted", async (_n, handler, body) => {
    setup(row({ enabled: false }));
    state.demo = true;
    const res = await post(handler as typeof enroll, body);
    expect(res.status).toBe(403);
    expect(state.db.calls.some((c) => c.table === "user_mfa" && c.op !== "select")).toBe(false);
  });
});

describe("R-8 migration 0060 not applied yet", () => {
  it("challenge accepts a valid TOTP code instead of 500", async () => {
    setup(row());
    state.noStepColumn = true;
    const res = await post(challenge, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(200);
  });

  it("enroll and disable retry without last_totp_step", async () => {
    setup(row({ enabled: false }));
    state.noStepColumn = true;
    expect((await post(enroll)).status).toBe(200);
    setup(row({ enabled: false }));
    state.noStepColumn = true;
    expect((await post(disable, {})).status).toBe(200);
  });
});
