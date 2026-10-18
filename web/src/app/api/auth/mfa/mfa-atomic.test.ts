/**
 * R-163 (wave 5, W5-B): each two-step state change and its audit row are ONE database call, while the
 * guess counter and the TOTP step burn stay OUTSIDE it and keep counting when the audit write fails.
 * The SQL is mirrored by mfa-rpc.testutil.ts and proved on a real database by
 * scripts/local-db/probe-atomic-security.mjs.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { authenticator } from "otplib";
import type { Actor } from "@/lib/auth/guard";
import { fakeDb, type Call } from "@/lib/auth/fake-db.testutil";
import { encrypt } from "@/lib/crypto";
import { hashBackupCode } from "@/lib/auth/mfa-factor";
import { mfaRpcMirror, type MfaAudit, type MfaRowLike, type MfaStore } from "./mfa-rpc.testutil";

const { state } = vi.hoisted(() => ({
  state: {
    actor: null as unknown,
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

const user: Actor = { type: "user", id: "u-1", label: "U", workspaceId: "ws-1", role: "member", principalId: "u-1", channel: "api" };
const SECRET = authenticator.generateSecret();
const BACKUP = "c".repeat(32);

beforeAll(() => {
  process.env.NOPM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

let row: MfaRowLike | null;
let store: MfaStore;

const mfaRow = (over: Partial<MfaRowLike> = {}): MfaRowLike => ({
  totp_secret: encrypt(SECRET),
  enabled: true,
  backup_codes: [hashBackupCode(BACKUP)],
  enrolled_at: "2026-10-01T00:00:00Z",
  last_totp_step: null,
  ...over,
});

function setup(initial: MfaRowLike | null) {
  row = initial;
  store = {
    get: () => row,
    set: (r) => {
      row = r;
    },
    audits: [],
    other: () => ({ data: { allowed: true, remaining: 9, retry_after_seconds: 0 } }),
  };
  const mirror = mfaRpcMirror(store);
  state.db = fakeDb((c: Call) => {
    if (c.table === "user_mfa" && c.op === "select") return { data: row };
    if (c.table === "user_mfa" && c.op === "update" && row) {
      // the TOTP step burn (consumeTotp): conditional on last_totp_step being lower
      const patch = c.payload as Partial<MfaRowLike>;
      if (typeof patch.last_totp_step === "number" && row.last_totp_step !== null && row.last_totp_step >= patch.last_totp_step) return { data: [] };
      row = { ...row, ...patch };
      return { data: [{ user_id: "u-1" }] };
    }
    if (c.table === "audit_log" && c.op === "select") return { count: 0 };
    return {};
  }, mirror);
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

const rpcNames = () => state.db.rpcCalls.map((c) => c.fn);
const auditOf = (fn: string) => state.db.rpcCalls.find((c) => c.fn === fn)!.args.p_audit as Record<string, unknown>;

beforeEach(() => {
  state.actor = user;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("R-163 each transition is one call carrying its audit description", () => {
  it("enroll: one function call (no direct user_mfa write, no separate audit insert) with the encrypted secret as an argument only", async () => {
    setup(mfaRow({ enabled: false }));
    const res = await post(enroll);
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(rpcNames().filter((n) => n.startsWith("nopm_mfa_"))).toEqual(["nopm_mfa_enroll"]);
    expect(state.db.calls.some((c) => c.table === "user_mfa" && c.op !== "select")).toBe(false);
    expect(state.db.calls.some((c) => c.table === "audit_log" && c.op === "insert")).toBe(false);
    const args = state.db.rpcCalls.find((c) => c.fn === "nopm_mfa_enroll")!.args;
    expect(args.p_workspace_id).toBe("ws-1");
    expect(args.p_user_id).toBe("u-1");
    expect(String(args.p_secret_enc).split(".")).toHaveLength(3); // AES-GCM envelope, never the raw seed
    // the raw secret the person sees once is nowhere in the audit description
    expect(JSON.stringify(auditOf("nopm_mfa_enroll"))).not.toContain(body.secret);
    expect(auditOf("nopm_mfa_enroll")).toMatchObject({ action: "mfa.enroll_started", target_type: "user_mfa", actor_id: "u-1", channel: "api" });
  });

  it("verify: backup codes are returned once, only their hashes travel to the database, the audit description has neither", async () => {
    setup(mfaRow({ enabled: false }));
    const res = await post(verify, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(200);
    const { backupCodes } = (await res.json()).data as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(8);
    const args = state.db.rpcCalls.find((c) => c.fn === "nopm_mfa_verify")!.args;
    expect(args.p_outcome).toBe("ok");
    expect(args.p_backup_hashes).toEqual(backupCodes.map(hashBackupCode));
    const auditText = JSON.stringify(args.p_audit);
    for (const c of backupCodes) expect(auditText).not.toContain(c);
    for (const h of args.p_backup_hashes as string[]) expect(auditText).not.toContain(h);
    expect(auditText).not.toContain(SECRET);
    expect(store.audits.map((a: MfaAudit) => a.action)).toEqual(["mfa.enabled"]);
  });

  it("challenge with a backup code: one call burns the code and audits; a second use of the same code is refused and audited as failed", async () => {
    setup(mfaRow());
    expect((await post(challenge, { code: BACKUP })).status).toBe(200);
    expect(row!.backup_codes).toEqual([]);
    expect(store.audits.map((a: MfaAudit) => a.action)).toEqual(["auth.mfa.challenge_passed"]);
    expect((await post(challenge, { code: BACKUP })).status).toBe(422);
    expect(store.audits.map((a: MfaAudit) => a.action)).toEqual(["auth.mfa.challenge_passed", "auth.mfa.challenge_failed"]);
  });

  it("disable: one call; the stored factor is wiped and mfa.disabled carries the proof used", async () => {
    setup(mfaRow());
    expect((await post(disable, { code: authenticator.generate(SECRET) })).status).toBe(200);
    expect(rpcNames().filter((n) => n.startsWith("nopm_mfa_"))).toEqual(["nopm_mfa_disable"]);
    expect(row).toMatchObject({ enabled: false, totp_secret: "" });
    expect(store.audits[0]).toMatchObject({ action: "mfa.disabled", before: { enabled: true }, after: { enabled: false, via: "code" } });
  });
});

describe("R-163(c) the counters never roll back when the audit write fails", () => {
  it("challenge: the attempt budget is spent BEFORE the database call, and a failed audit leaves the burned step burned", async () => {
    setup(mfaRow());
    const code = authenticator.generate(SECRET);
    store.failAudit = true;
    const res = await post(challenge, { code });
    expect(res.status).toBe(500); // fail-closed: no cookie, no pass
    // the budget call came first and is not part of the audited function
    expect(rpcNames()[0]).toBe("nopm_rate_check");
    expect(rpcNames().indexOf("nopm_rate_check")).toBeLessThan(rpcNames().indexOf("nopm_mfa_challenge"));
    // the step burn is a separate write that persisted: the same code is now a replay, not a free second guess
    expect(typeof row!.last_totp_step).toBe("number");
    const again = await post(challenge, { code });
    expect(again.status).toBe(422);
    expect(store.audits.map((a: MfaAudit) => a.action)).toEqual(["auth.mfa.challenge_failed"]);
  });

  it("challenge: a wrong code whose failure audit cannot be written still costs the attempt (500, budget spent)", async () => {
    setup(mfaRow());
    store.failAudit = true;
    const res = await post(challenge, { code: "000000" });
    expect(res.status).toBe(500);
    const mfaCall = state.db.rpcCalls.find((c) => c.fn === "nopm_rate_check" && String(c.args.p_key).startsWith("mfa-attempt:"));
    expect(mfaCall).toBeTruthy();
    expect(rpcNames().indexOf("nopm_rate_check")).toBeLessThan(rpcNames().indexOf("nopm_mfa_challenge"));
  });

  it("verify: a failing audit leaves the factor OFF and returns no backup codes, but the step stays burned", async () => {
    setup(mfaRow({ enabled: false }));
    store.failAudit = true;
    const res = await post(verify, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(500);
    expect(row!.enabled).toBe(false);
    expect(row!.backup_codes).toEqual([hashBackupCode(BACKUP)]);
    expect(typeof row!.last_totp_step).toBe("number");
    expect(rpcNames()[0]).toBe("nopm_rate_check");
  });

  it("disable: a failing audit leaves two-step ON", async () => {
    setup(mfaRow());
    store.failAudit = true;
    const res = await post(disable, { code: authenticator.generate(SECRET) });
    expect(res.status).toBe(500);
    expect(row!.enabled).toBe(true);
    expect(row!.totp_secret).not.toBe("");
  });

  it("enroll: a failing audit keeps the previous (unconfirmed) secret", async () => {
    setup(mfaRow({ enabled: false }));
    const before = row!.totp_secret;
    // make it a fresh enrolment: old pending one is beyond the one-hour reuse window
    row = { ...row!, enrolled_at: "2026-01-01T00:00:00Z" };
    store.failAudit = true;
    const res = await post(enroll);
    expect(res.status).toBe(500);
    expect(row!.totp_secret).toBe(before);
  });
});
