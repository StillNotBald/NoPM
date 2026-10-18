import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";
import { hashBackupCode } from "@/lib/auth/mfa-factor";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { DEMO_RESTRICTED_MESSAGE, isDemoActor } from "@/lib/auth/demo";
import type { Actor } from "@/lib/auth/guard";

/**
 * People & roles (Q-ACC-1 / 3 / 5 / 21). A person is never deleted: 31 foreign
 * keys point at profiles. "Removed" is profiles.status (migration 0083); the
 * RPCs do the change, the token/invite clean-up and the audit row in one
 * transaction. The login itself is banned/unbanned here so a removed person
 * cannot sign in or refresh a session.
 */

export const MEMBER_ROLE_VALUES = ["viewer", "member", "manager", "admin"] as const;
export type MemberRoleValue = (typeof MEMBER_ROLE_VALUES)[number];

export const LAST_ADMIN_MESSAGE = "You cannot remove the last admin. Make someone else an admin first.";
/** Roughly 100 years; the same value the leaver runbook uses. */
const BAN_FOREVER = "876000h";
export const BACKUP_CODE_COUNT = 8;

type RpcError = { message?: string; code?: string } | null | undefined;

/** Maps the typed exceptions of nopm_member_change / nopm_member_mfa_reset (0083) to the API contract. */
export function mapMemberRpcError(error: RpcError): Error {
  const m = `${error?.message ?? ""} ${error?.code ?? ""}`;
  if (m.includes("LAST_ADMIN") || error?.code === "P0010") return new RuleError(LAST_ADMIN_MESSAGE, "last_admin");
  if (m.includes("NOT_FOUND") || error?.code === "P0002") return new NotFoundError("Member not found");
  if (m.includes("ROLE_NOT_PERMITTED") || error?.code === "P0018")
    return new ScopeError("Only a workspace admin can do this");
  // NOT_REMOVED must be tested first: its text contains "REMOVED".
  if (m.includes("NOT_REMOVED") || error?.code === "P0012")
    return new RuleError("This person has not been removed.", "member_not_removed");
  if (m.includes("REMOVED") || error?.code === "P0011")
    return new RuleError("This person has been removed from the workspace.", "member_removed");
  if (m.includes("NO_CHANGE") || error?.code === "P0007")
    return new RuleError("That is already their role.", "no_change");
  if (m.includes("SELF_RESET") || error?.code === "P0013")
    return new RuleError("Ask another admin to reset your two-step.", "self_reset");
  return new Error(error?.message || "Member change failed");
}

/** Members are managed from a signed-in session only (never a token or agent). */
export async function assertMemberAdminSession(actor: Actor): Promise<void> {
  if (actor.type !== "user") throw new ScopeError("Managing people requires a signed-in session");
  if (await isDemoActor(actor)) throw new ScopeError(DEMO_RESTRICTED_MESSAGE, "demo_restricted");
}

export function assertCanListMembers(actor: Actor): void {
  if (actor.type !== "user" || !["admin", "manager"].includes(actor.role ?? "")) {
    throw new ScopeError("Listing people requires an admin or manager session");
  }
}

type ChangeResult = {
  member: Record<string, unknown>;
  revoked_tokens: string[];
  cancelled_invites: string[];
};

async function callChange(
  actor: Actor,
  targetId: string,
  action: "set_role" | "remove" | "restore",
  newRole: MemberRoleValue | null,
): Promise<ChangeResult> {
  const db = createAdminClient();
  const { data, error } = await db.rpc("nopm_member_change", {
    p_workspace_id: actor.workspaceId,
    p_target_id: targetId,
    p_action: action,
    p_new_role: newRole,
    p_actor_id: actor.id,
    p_actor_label: actor.label,
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
  });
  if (error) throw mapMemberRpcError(error);
  return data as ChangeResult;
}

export async function changeMemberRole(actor: Actor, targetId: string, role: MemberRoleValue) {
  return callChange(actor, targetId, "set_role", role);
}

/** Ban or unban the Supabase login so a removed person cannot sign in or refresh a session. */
async function setLoginBan(targetId: string, banned: boolean): Promise<void> {
  const db = createAdminClient();
  const { error } = await db.auth.admin.updateUserById(targetId, { ban_duration: banned ? BAN_FOREVER : "none" });
  if (error) throw new Error(`Could not ${banned ? "block" : "unblock"} the sign-in: ${error.message}`);
}

/**
 * Best effort: end every live session of a removed person (service-role SQL
 * function, migration 0087). Access JWTs already issued stay valid until they
 * expire, but the RLS helpers (0087) stop answering for a removed profile, so
 * the database API is closed to them either way. Never throws.
 */
async function endSessions(targetId: string): Promise<void> {
  try {
    await createAdminClient().rpc("nopm_revoke_user_sessions", { p_user_id: targetId });
  } catch {
    /* backstop only - the ban and the RLS status check are the controls */
  }
}

/**
 * Remove (or leave, when actor === target). Tokens revoked and invites cancelled
 * atomically in the RPC. If the person was already removed (for example the ban
 * call failed last time) the login ban is simply retried - no second audit row.
 */
export async function removeMember(actor: Actor, targetId: string) {
  let result: ChangeResult | null = null;
  let alreadyRemoved = false;
  try {
    result = await callChange(actor, targetId, "remove", null);
  } catch (e) {
    if (e instanceof RuleError && e.code === "member_removed") alreadyRemoved = true;
    else throw e;
  }
  await setLoginBan(targetId, true);
  await endSessions(targetId);
  if (alreadyRemoved) return { member: null, revoked_tokens: [], cancelled_invites: [], already_removed: true };
  return { ...(result as ChangeResult), already_removed: false };
}

/** Reactivate the same profile (a re-invited person gets their member record back). */
export async function restoreMember(actor: Actor, targetId: string, role: MemberRoleValue | null) {
  let result: ChangeResult | null = null;
  try {
    result = await callChange(actor, targetId, "restore", role);
  } catch (e) {
    // Retryable: the RPC committed last time but the unban failed. The profile is
    // active, so only the unban is repeated - no second audit row.
    if (!(e instanceof RuleError) || e.code !== "member_not_removed") throw e;
    const { data, error } = await createAdminClient()
      .from("profiles")
      .select("status")
      .eq("id", targetId)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data || data.status !== "active") throw e;
    await setLoginBan(targetId, false);
    return { member: null, revoked_tokens: [], cancelled_invites: [], already_restored: true } as unknown as ChangeResult & { already_restored: boolean };
  }
  await setLoginBan(targetId, false);
  return result;
}

/**
 * Proof of ownership for an invite that restores a REMOVED account (R3-2): the
 * person signs in with their OWN existing password. An invite never sets or
 * resets a password. The login is banned while removed, so it is lifted for the
 * single check and put back at once if the check fails (the profile stays
 * removed meanwhile, so the console and the RLS helpers stay closed).
 */
export async function verifyRemovedMemberPassword(targetId: string, email: string, password: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return false;
  await setLoginBan(targetId, false);
  let proven = false;
  try {
    const anonClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
    proven = !error && data?.user?.id === targetId;
    if (data?.session) await anonClient.auth.signOut().catch(() => undefined);
  } finally {
    if (!proven) await setLoginBan(targetId, true);
  }
  return proven;
}

/**
 * Admin resets a member's two-step: the old factor is replaced by a random secret
 * nobody knows plus one-time backup codes. The member signs in with one code, then
 * turns two-step off (recent-challenge rule) and enrols again. Codes returned ONCE.
 */
export async function resetMemberMfa(actor: Actor, targetId: string) {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => randomBytes(16).toString("hex"));
  const db = createAdminClient();
  const { error } = await db.rpc("nopm_member_mfa_reset", {
    p_workspace_id: actor.workspaceId,
    p_target_id: targetId,
    p_secret_enc: encrypt(randomBytes(20).toString("hex")),
    p_backup_hashes: codes.map(hashBackupCode),
    p_actor_id: actor.id,
    p_actor_label: actor.label,
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
  });
  if (error) throw mapMemberRpcError(error);
  return { backup_codes: codes };
}

export type MemberRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: MemberRoleValue;
  status: "active" | "removed";
  created_at: string;
  removed_at: string | null;
  mfa_enabled: boolean;
};

/** Which of these profile ids (already verified in the caller's workspace) have two-step on. */
export async function memberMfaEnabled(profileIds: string[]): Promise<Set<string>> {
  const mfa = new Set<string>();
  if (profileIds.length === 0) return mfa;
  const db = createAdminClient();
  const { data, error } = await db.from("user_mfa").select("user_id").eq("enabled", true).in("user_id", profileIds);
  if (error) throw error;
  for (const x of data ?? []) mfa.add(x.user_id);
  return mfa;
}

export async function listMembers(workspaceId: string): Promise<MemberRow[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("profiles")
    .select("id, email, display_name, role, status, created_at, removed_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const rows = data ?? [];
  const mfa = new Set<string>();
  if (rows.length > 0) {
    const { data: m, error: mErr } = await db
      .from("user_mfa")
      .select("user_id")
      .eq("enabled", true)
      .in("user_id", rows.map((r) => r.id));
    if (mErr) throw mErr;
    for (const x of m ?? []) mfa.add(x.user_id);
  }
  return rows.map((r) => ({ ...r, mfa_enabled: mfa.has(r.id) })) as MemberRow[];
}
