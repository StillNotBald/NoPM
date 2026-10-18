/**
 * Test-only in-memory mirrors of the migration 0109 functions (R-163, R-164): nopm_connector_write,
 * nopm_github_connector_write, nopm_revoke_other_invites and nopm_link_identity. FakeDb.rpc delegates here
 * (the same way it delegates nopm_mutate_audited), so route and library tests run the real handlers against
 * real in-memory rows and the same guard order, error codes and result shapes as the SQL.
 *
 * Atomicity is mirrored too: every function snapshots the tables it may touch and restores them when the
 * audit write fails, exactly like the transaction does. The audit row goes through `writeAudit` (which the
 * tests either mock, to assert on the call, or let write into the fake audit_log), so the existing
 * "audited once, without the secret" assertions keep their meaning. The SQL itself is proved by
 * scripts/local-db/probe-atomic-security.mjs on a real database.
 *
 * Not imported by any app code (the scan skips every path containing "test-support").
 */
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { normalizeConfig, toAuditConnector, toPublicConnector } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";

type Row = Record<string, unknown>;
type PgError = { code?: string; message: string };
type Result = { data: unknown; error: PgError | null; count: null };

/** The slice of FakeDb the mirrors use. */
export type SecurityFakeDb = {
  tables: Record<string, Row[]>;
  rows(table: string): Row[];
  nextId(): string;
};

const ok = (data: unknown): Result => ({ data, error: null, count: null });
const fail = (code: string, message: string): Result => ({ data: null, error: { code, message }, count: null });
const nowIso = () => new Date().toISOString();

/** Names this module answers. */
export const SECURITY_RPCS = new Set([
  "nopm_connector_write",
  "nopm_github_connector_write",
  "nopm_revoke_other_invites",
  "nopm_link_identity",
]);

/** The actor the audit object describes, in the shape writeAudit takes. */
export function actorFromAudit(workspaceId: string, a: Row): Actor {
  return {
    type: a.actor_type as Actor["type"],
    id: a.actor_id as string,
    label: a.actor_label as string,
    workspaceId,
    channel: (a.channel ?? undefined) as Actor["channel"],
    requestId: (a.request_id ?? undefined) as string | undefined,
    principalId: (a.principal_id ?? undefined) as string | undefined,
    viaConnectorId: (a.via_connector_id ?? undefined) as string | undefined,
    externalEventId: (a.external_event_id ?? undefined) as string | undefined,
    externalActorRef: (a.external_actor_ref ?? undefined) as string | undefined,
  } as Actor;
}

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** nopm_audit_insert: validates like the helper, then hands the row to writeAudit. A rejection rolls the caller back. */
async function auditInsert(
  workspaceId: string,
  audit: Row | null | undefined,
  targetId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (!audit || !ACTION.test(String(audit.action ?? ""))) throw Object.assign(new Error("INVALID_ACTION"), { code: "P0057" });
  if (audit.actor_type !== "user" && audit.actor_type !== "token") throw Object.assign(new Error("INVALID_ACTOR"), { code: "P0058" });
  await writeAudit({
    workspaceId,
    actor: actorFromAudit(workspaceId, audit),
    action: audit.action as string,
    targetType: audit.target_type as string,
    targetId,
    before: (before ?? null) as never,
    after: (after ?? null) as never,
  });
}

/** Run `fn` as one transaction over the whole fake: any throw restores every table. */
export async function transaction(db: SecurityFakeDb, fn: () => Promise<Result>): Promise<Result> {
  const snapshot = structuredClone(db.tables);
  try {
    return await fn();
  } catch (e) {
    // Restore in place so the arrays tests hold on to stay valid.
    for (const name of new Set([...Object.keys(db.tables), ...Object.keys(snapshot)])) {
      const live = db.tables[name] ?? (db.tables[name] = []);
      live.splice(0, live.length, ...(snapshot[name] ?? []));
    }
    const err = e as { code?: string; message?: string };
    return fail(err.code ?? "XX000", err.message ?? "audit insert failed");
  }
}

/** Break out of a transaction with a typed error (the SQL `raise exception`). */
class Raise extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const connectorView = (row: Row, secrets: Row | null | undefined) => {
  const stored = row as unknown as ConnectorRow;
  return { ...toAuditConnector(toPublicConnector({ ...stored, config: normalizeConfig(stored.config) })), ...(secrets ?? {}) };
};

function connectorWrite(db: SecurityFakeDb, args: Row): Promise<Result> {
  return transaction(db, async () => {
    const ws = args.p_workspace_id as string;
    const patch = (args.p_patch ?? {}) as Row;
    const rows = db.rows("integration_connectors");
    if (args.p_op === "create") {
      if (rows.some((r) => r.workspace_id === ws && r.kind === "lark" && r.status !== "revoked")) {
        throw new Raise("23505", 'duplicate key value violates unique constraint "uniq_live_connector_per_kind"');
      }
      const now = nowIso();
      const row: Row = {
        id: db.nextId(),
        workspace_id: ws,
        kind: "lark",
        name: patch.name,
        status: "active",
        config: patch.config ?? {},
        secret_enc: patch.secret_enc,
        relay_secret_hash: patch.relay_secret_hash ?? null,
        tenant_key: null,
        created_by: args.p_created_by ?? null,
        created_at: now,
        updated_at: now,
        revoked_at: null,
      };
      rows.push(row);
      await auditInsert(ws, args.p_audit as Row, row.id as string, null, { ...connectorView(row, args.p_secrets as Row), ...((args.p_extras ?? {}) as Row) });
      return ok({ ...row });
    }
    if (args.p_op !== "update") throw new Raise("P0085", "INVALID_OP");
    const row = rows.find((r) => r.id === args.p_connector_id && r.workspace_id === ws && r.kind === "lark");
    if (!row) throw new Raise("P0002", "CONNECTOR_NOT_FOUND");
    if (row.status === "revoked") throw new Raise("P0001", "CONNECTOR_REVOKED");
    for (const key of ["name", "status", "config", "secret_enc", "relay_secret_hash", "tenant_key"]) {
      if (key in patch) row[key] = patch[key] ?? null;
    }
    row.updated_at = nowIso();
    await auditInsert(ws, args.p_audit as Row, row.id as string, args.p_before ?? null, { ...connectorView(row, args.p_secrets as Row), ...((args.p_extras ?? {}) as Row) });
    return ok({ ...row });
  });
}

function githubWrite(db: SecurityFakeDb, args: Row): Promise<Result> {
  return transaction(db, async () => {
    const ws = args.p_workspace_id as string;
    const op = args.p_op as string;
    const rows = db.rows("integration_connectors");
    if (!["create", "update", "revoke"].includes(op)) throw new Raise("P0085", "INVALID_OP");
    if (op === "create") {
      if (rows.some((r) => r.workspace_id === ws && r.kind === "github" && r.status !== "revoked")) {
        throw new Raise("23505", 'duplicate key value violates unique constraint "uniq_live_connector_per_kind"');
      }
      const now = nowIso();
      const row: Row = {
        id: db.nextId(),
        workspace_id: ws,
        kind: "github",
        name: args.p_name,
        status: "active",
        config: {},
        secret_enc: args.p_secret_enc,
        relay_secret_hash: null,
        tenant_key: null,
        created_by: args.p_created_by ?? null,
        created_at: now,
        updated_at: now,
        revoked_at: null,
      };
      rows.push(row);
      await auditInsert(ws, args.p_audit as Row, row.id as string, null, { kind: "github", name: row.name, status: row.status });
      return ok({ connector: { ...row }, rules_written: false });
    }
    const find = () => rows.find((r) => r.id === args.p_connector_id && r.workspace_id === ws && r.kind === "github");
    if (op === "revoke") {
      const cur = find();
      if (!cur) throw new Raise("P0002", "CONNECTOR_NOT_FOUND");
      if (cur.status === "revoked") throw new Raise("P0001", "CONNECTOR_REVOKED");
      const was = cur.status;
      cur.status = "revoked";
      cur.revoked_at = nowIso();
      cur.updated_at = nowIso();
      await auditInsert(ws, args.p_audit as Row, cur.id as string, { kind: "github", status: was }, { kind: "github", status: "revoked" });
      return ok({ connector: { ...cur }, rules_written: false });
    }
    let connector: Row | null = null;
    if (args.p_connector_id) {
      const cur = find();
      if (!cur || cur.status === "revoked") throw new Raise("P0002", "CONNECTOR_NOT_FOUND");
      const was = cur.status;
      if (args.p_status != null) cur.status = args.p_status;
      if (args.p_secret_enc != null) cur.secret_enc = args.p_secret_enc;
      cur.updated_at = nowIso();
      connector = { ...cur };
      await auditInsert(ws, args.p_audit as Row, cur.id as string, { kind: "github", status: was }, {
        kind: "github",
        status: cur.status,
        secret_rotated: args.p_secret_rotated === true,
      });
    }
    let rulesWritten = false;
    if (args.p_rules_after != null) {
      const workspace = db.rows("workspaces").find((w) => w.id === ws);
      if (!workspace) throw new Raise("P0002", "NOT_FOUND");
      workspace.work_event_rules = args.p_rules_after;
      await auditInsert(
        ws,
        { ...(args.p_audit as Row), action: "work_event_rules.update", target_type: "workspace" },
        ws,
        args.p_rules_before ?? null,
        args.p_rules_after,
      );
      rulesWritten = true;
    }
    return ok({ connector, rules_written: rulesWritten });
  });
}

function revokeOtherInvites(db: SecurityFakeDb, args: Row): Promise<Result> {
  return transaction(db, async () => {
    const ws = args.p_workspace_id as string;
    const email = String(args.p_email ?? "");
    if (!ws || !email) throw new Raise("P0002", "NOT_FOUND");
    const ids: string[] = [];
    for (const inv of db.rows("invites")) {
      if (inv.workspace_id !== ws || String(inv.email).toLowerCase() !== email.toLowerCase()) continue;
      if (inv.id === args.p_keep_invite_id || inv.revoked === true || inv.accepted_at) continue;
      inv.revoked = true;
      ids.push(inv.id as string);
      await auditInsert(
        ws,
        args.p_audit as Row,
        inv.id as string,
        { email: inv.email, role: inv.role, revoked: false },
        { email: inv.email, role: inv.role, revoked: true, reason: "another invite for this email was accepted" },
      );
    }
    return ok(ids);
  });
}

const mask = (id: string) => (id.length <= 10 ? `${id.slice(0, 2)}…` : `${id.slice(0, 6)}…${id.slice(-4)}`);

function linkIdentity(db: SecurityFakeDb, args: Row): Promise<Result> {
  return transaction(db, async () => {
    const ws = args.p_workspace_id as string;
    const tenant = args.p_external_tenant as string;
    const extUser = args.p_external_user_id as string;
    const linked = (status: string, extra: Row = {}) => ok({ status, ...extra });
    const conn = db.rows("integration_connectors").find((c) => c.id === args.p_connector_id && c.workspace_id === ws);
    if (!conn) throw new Raise("P0002", "CONNECTOR_NOT_FOUND");
    if (conn.status !== "active") return linked("paused");
    if (conn.tenant_key != null && conn.tenant_key !== tenant) return linked("forbidden", { reason: "tenant_mismatch" });

    const code = db.rows("identity_link_codes").find((c) => c.code_hash === args.p_code_hash && c.workspace_id === ws && c.connector_id === conn.id);
    if (!code || code.profile_id !== args.p_profile_id) return linked("invalid_code");
    if (code.used_at) return linked("already_used");
    if (new Date(code.expires_at as string).getTime() <= Date.now()) return linked("expired");

    const profile = db.rows("profiles").find((p) => p.id === code.profile_id && p.workspace_id === ws);
    if (!profile) return linked("invalid_code");
    const label = (profile.display_name as string) || (profile.email as string) || (profile.id as string);
    const ref = `${conn.kind}:${mask(tenant)}:${mask(extUser)}`;
    const identities = db.rows("external_identities");

    const same = identities.find(
      (i) => i.workspace_id === ws && i.connector_id === conn.id && i.external_tenant === tenant && i.external_user_id === extUser && i.revoked_at == null,
    );
    if (same) {
      if (same.profile_id !== profile.id) return linked("conflict", { reason: "account_taken" });
      return linked("linked", { already_linked: true, profile_label: label });
    }

    const held = identities.find((i) => i.workspace_id === ws && i.connector_id === conn.id && i.profile_id === profile.id && i.revoked_at == null);
    if (held) {
      // Best effort in a sub-transaction: if the blocked row cannot be written the code stays usable.
      const snapshot = structuredClone(db.tables);
      try {
        code.used_at = nowIso();
        await auditInsert(
          ws,
          { ...(args.p_audit as Row), action: "integration.identity.link.blocked" },
          held.id as string,
          null,
          {
            connector_id: conn.id,
            provider: conn.kind,
            profile_id: profile.id,
            reason: "profile_already_linked",
            external_ref: ref,
            existing_external_ref: `${conn.kind}:${mask(held.external_tenant as string)}:${mask(held.external_user_id as string)}`,
          },
        );
      } catch {
        for (const name of Object.keys(snapshot)) {
          const live = db.tables[name] ?? (db.tables[name] = []);
          live.splice(0, live.length, ...snapshot[name]);
        }
      }
      return linked("conflict", { reason: "already_linked" });
    }

    let pinned = false;
    if ((profile.role === "admin" || profile.role === "manager") && conn.tenant_key == null) {
      conn.tenant_key = tenant;
      pinned = true;
    }
    const now = nowIso();
    code.used_at = now;
    const replaced = identities.filter((i) => i.workspace_id === ws && i.connector_id === conn.id && i.profile_id === profile.id && i.revoked_at == null);
    for (const r of replaced) r.revoked_at = now;
    if (identities.some((i) => i.connector_id === conn.id && i.external_tenant === tenant && i.external_user_id === extUser && i.revoked_at == null)) {
      throw new Raise("23505", "duplicate key value violates unique constraint");
    }
    const identity: Row = {
      id: db.nextId(),
      workspace_id: ws,
      connector_id: conn.id,
      provider: conn.kind,
      external_tenant: tenant,
      external_user_id: extUser,
      external_union_id: args.p_external_union_id ?? null,
      display_name: args.p_display_name ?? null,
      profile_id: profile.id,
      linked_at: now,
      revoked_at: null,
    };
    identities.push(identity);
    await auditInsert(
      ws,
      args.p_audit as Row,
      identity.id as string,
      replaced.length
        ? { external_ref: `${conn.kind}:${mask(replaced[0].external_tenant as string)}:${mask(replaced[0].external_user_id as string)}` }
        : null,
      {
        connector_id: conn.id,
        provider: conn.kind,
        profile_id: profile.id,
        external_ref: ref,
        replaced_previous_link: replaced.length > 0,
        tenant_pinned: pinned,
      },
    );
    return linked("linked", {
      already_linked: false,
      profile_label: label,
      profile_id: profile.id,
      displaced: replaced
        .filter((r) => !(r.external_tenant === tenant && r.external_user_id === extUser))
        .map((r) => ({ external_tenant: r.external_tenant, external_user_id: r.external_user_id })),
    });
  });
}

/** Answer one of the 0109 functions, or null when the name is not one of them. */
export function securityRpc(db: SecurityFakeDb, name: string, args: Row): Promise<Result> | null {
  switch (name) {
    case "nopm_connector_write":
      return connectorWrite(db, args);
    case "nopm_github_connector_write":
      return githubWrite(db, args);
    case "nopm_revoke_other_invites":
      return revokeOtherInvites(db, args);
    case "nopm_link_identity":
      return linkIdentity(db, args);
    default:
      return null;
  }
}
