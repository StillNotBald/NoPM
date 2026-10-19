/**
 * Test-only in-memory mirror of the four migration 0109 two-step functions (nopm_mfa_enroll, nopm_mfa_challenge,
 * nopm_mfa_verify, nopm_mfa_disable), for the route tests that use the recording `fakeDb`. Same guards, same audit
 * actions and the same result shape as the SQL; one audit entry per call; a call whose audit write fails changes
 * nothing (the transaction). Not a test file (no `.test.`), so vitest does not collect it. The SQL itself is
 * proved by scripts/local-db/probe-atomic-security.mjs.
 */
export type MfaRowLike = {
  totp_secret: string;
  enabled: boolean;
  backup_codes: string[] | null;
  enrolled_at: string;
  last_totp_step: number | null;
};

export type MfaAudit = { action: string; before: unknown; after: unknown; targetId: unknown; audit: Record<string, unknown> };

export type MfaStore = {
  get: () => MfaRowLike | null;
  set: (row: MfaRowLike | null) => void;
  audits: MfaAudit[];
  /** Make the next audit write fail: the whole call is rolled back. */
  failAudit?: boolean;
  /** Simulates a database without migration 0060: the functions that reset last_totp_step fail with 42703. */
  missingStepColumn?: () => boolean;
  /** Called for anything that is not an MFA function (the rate limiter). */
  other: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string; code?: string } | null };
};

const MISSING = 'column "last_totp_step" of relation "user_mfa" does not exist';

type Reply = { data?: unknown; error?: { message: string; code?: string } | null };

export function mfaRpcMirror(store: MfaStore) {
  const audit = (args: Record<string, unknown>, action: string, before: unknown, after: unknown) => {
    const a = (args.p_audit ?? {}) as Record<string, unknown>;
    if (store.failAudit) {
      store.failAudit = false;
      throw Object.assign(new Error("audit insert failed"), { code: "XX000" });
    }
    if (a.actor_type !== "user" && a.actor_type !== "token") throw Object.assign(new Error("INVALID_ACTOR"), { code: "P0058" });
    store.audits.push({ action, before, after, targetId: args.p_user_id, audit: a });
  };

  return (fn: string, args: Record<string, unknown>): Reply => {
    if (!fn.startsWith("nopm_mfa_")) return store.other(fn, args);
    const snapshot = store.get() ? { ...store.get()! } : null;
    const auditCount = store.audits.length;
    try {
      const row = store.get();
      switch (fn) {
        case "nopm_mfa_enroll": {
          if (args.p_reset_step !== false && store.missingStepColumn?.()) return { error: { message: MISSING, code: "42703" } };
          store.set({
            totp_secret: args.p_secret_enc as string,
            enabled: false,
            backup_codes: [],
            enrolled_at: new Date().toISOString(),
            last_totp_step: args.p_reset_step === false ? (row?.last_totp_step ?? null) : null,
          });
          audit(args, "mfa.enroll_started", null, { enabled: false });
          return { data: { enrolled: true } };
        }
        case "nopm_mfa_challenge": {
          let outcome = args.p_outcome as string;
          if (outcome === "backup_code") {
            const hash = args.p_backup_hash as string;
            if (row?.backup_codes?.includes(hash)) store.set({ ...row, backup_codes: row.backup_codes.filter((h) => h !== hash) });
            else outcome = "failed";
          }
          if (outcome === "failed") {
            audit(args, "auth.mfa.challenge_failed", null, null);
            return { data: { result: "failed" } };
          }
          audit(args, "auth.mfa.challenge_passed", null, { via: outcome === "backup_code" ? "backup_code" : "totp" });
          return { data: { result: "passed" } };
        }
        case "nopm_mfa_verify": {
          if (args.p_outcome !== "ok") {
            audit(args, "auth.mfa.verify_failed", null, { reason: args.p_outcome });
            return { data: { enabled: false } };
          }
          if (!row) return { error: { message: "NOT_FOUND", code: "P0002" } };
          store.set({ ...row, enabled: true, backup_codes: (args.p_backup_hashes as string[] | null) ?? [] });
          audit(args, "mfa.enabled", { enabled: row.enabled }, { enabled: true });
          return { data: { enabled: true } };
        }
        case "nopm_mfa_disable": {
          if (args.p_mode === "failed") {
            audit(args, "auth.mfa.disable_failed", null, null);
            return { data: { enabled: null } };
          }
          if (!row) return { error: { message: "NOT_FOUND", code: "P0002" } };
          if (args.p_reset_step !== false && store.missingStepColumn?.()) return { error: { message: MISSING, code: "42703" } };
          store.set({
            ...row,
            enabled: false,
            totp_secret: "",
            backup_codes: [],
            last_totp_step: args.p_reset_step === false ? row.last_totp_step : null,
          });
          audit(args, "mfa.disabled", { enabled: row.enabled }, { enabled: false, via: args.p_mode });
          return { data: { enabled: false } };
        }
        default:
          return { error: { message: "INVALID_OP", code: "P0085" } };
      }
    } catch (e) {
      store.set(snapshot);
      store.audits.length = auditCount;
      const err = e as { message?: string; code?: string };
      return { error: { message: err.message ?? "failed", code: err.code } };
    }
  };
}
