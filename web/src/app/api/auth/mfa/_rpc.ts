import type { Actor } from "@/lib/auth/guard";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import { isMissingTotpStepColumn } from "@/lib/auth/mfa-factor";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * The four two-step state changes are database functions (migration 0109, R-163): each changes `user_mfa`
 * AND writes its audit row in ONE transaction, through the shared helper nopm_audit_insert.
 *
 * What stays OUTSIDE these calls, on purpose: the attempt counter (`spendMfaAttempt`) and the TOTP step
 * burn (`consumeTotp`) in lib/auth/mfa-factor.ts. They run before and persist on their own, so a failing
 * audit write can never hand out a free guess. The functions only record the OUTCOME the app decided.
 *
 * The secret and the backup codes never enter the audit object: the database functions receive the
 * encrypted secret and the SHA-256 hashes as separate arguments and write neither into an audit row.
 */

type Db = ReturnType<typeof createAdminClient>;

type RpcResult<T> = { data: T | null; error: { message?: string; code?: string } | null };

async function call<T>(
  db: Db,
  fn: string,
  actor: Actor,
  audit: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<RpcResult<T>> {
  const { data, error } = await db.rpc(fn, {
    p_workspace_id: actor.workspaceId,
    p_user_id: actor.id,
    ...args,
    p_audit: audit,
  });
  return { data: (data ?? null) as T | null, error };
}

/** Start (or restart) enrolment: user_mfa row + mfa.enroll_started. Retries once without last_totp_step when that column is missing (R-8). */
export async function mfaEnroll(db: Db, actor: Actor, secretEnc: string): Promise<void> {
  let { error } = await call(db, "nopm_mfa_enroll", actor, buildRpcAudit(actor, "mfa.enroll_started", "user_mfa"), { p_secret_enc: secretEnc, p_reset_step: true });
  if (error && isMissingTotpStepColumn(error)) {
    ({ error } = await call(db, "nopm_mfa_enroll", actor, buildRpcAudit(actor, "mfa.enroll_started", "user_mfa"), { p_secret_enc: secretEnc, p_reset_step: false }));
  }
  if (error) throw error;
}

/** Record a challenge outcome. 'backup_code' burns the code with a compare-and-set; a lost race comes back 'failed'. */
export async function mfaChallenge(
  db: Db,
  actor: Actor,
  outcome: "totp" | "backup_code" | "failed",
  backupHash: string | null = null,
): Promise<"passed" | "failed"> {
  // The action matches the outcome the app decided; the function turns a lost backup-code race into the failed action itself.
  const challengeAudit =
    outcome === "failed"
      ? buildRpcAudit(actor, "auth.mfa.challenge_failed", "user_mfa")
      : buildRpcAudit(actor, "auth.mfa.challenge_passed", "user_mfa");
  const { data, error } = await call<{ result: "passed" | "failed" }>(db, "nopm_mfa_challenge", actor, challengeAudit, {
    p_outcome: outcome,
    p_backup_hash: backupHash,
  });
  if (error) throw error;
  return data?.result === "passed" ? "passed" : "failed";
}

/** Confirm enrolment ('ok': enable + store the backup code HASHES + mfa.enabled) or record a failed code. */
export async function mfaVerify(
  db: Db,
  actor: Actor,
  outcome: "ok" | "invalid" | "replay",
  backupHashes: string[] | null = null,
): Promise<void> {
  const audit = outcome === "ok" ? buildRpcAudit(actor, "mfa.enabled", "user_mfa") : buildRpcAudit(actor, "auth.mfa.verify_failed", "user_mfa");
  const { error } = await call(db, "nopm_mfa_verify", actor, audit, { p_outcome: outcome, p_backup_hashes: backupHashes });
  if (error) throw error;
}

/** Turn the factor off (mfa.disabled) or record a failed attempt ('failed'). Retries once without last_totp_step when that column is missing (R-8). */
export async function mfaDisable(
  db: Db,
  actor: Actor,
  mode: "recent_challenge" | "code" | "cancel_enrollment" | "failed",
): Promise<void> {
  const disableAudit =
    mode === "failed" ? buildRpcAudit(actor, "auth.mfa.disable_failed", "user_mfa") : buildRpcAudit(actor, "mfa.disabled", "user_mfa");
  let { error } = await call(db, "nopm_mfa_disable", actor, disableAudit, { p_mode: mode, p_reset_step: true });
  if (error && isMissingTotpStepColumn(error)) {
    ({ error } = await call(db, "nopm_mfa_disable", actor, disableAudit, { p_mode: mode, p_reset_step: false }));
  }
  if (error) throw error;
}
