import { createHash } from "node:crypto";

/**
 * Reference implementation of the audit hash chain (migration 0104).
 *
 * The database computes the chain (trg_audit_chain -> nopm_audit_row_hash); this module is the
 * same algorithm in TypeScript so an auditor, an export check or a test can recompute a hash
 * offline. hash.test.ts pins a fixture, so a change to the SQL canonical form that is not
 * mirrored here (or the reverse) fails the build.
 *
 *   row_hash = sha256_hex( coalesce(prev_hash, '') || '|' || canonical(row) )
 *   canonical(row) = text of the jsonb array
 *     [id, workspace_id, actor_type, actor_id, actor_label, principal_id, action,
 *      target_type, target_id, before, after, channel, request_id, created_at (UTC, ISO with
 *      microseconds and a Z), via_connector_id, external_event_id, external_actor_ref, chain_seq]
 *
 * Postgres prints jsonb with `", "` and `": "` separators and orders object keys by length,
 * then bytewise; jsonbText reproduces that.
 */
export type AuditHashRow = {
  id: string;
  workspace_id: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  principal_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  channel: string | null;
  request_id: string | null;
  /** UTC, formatted YYYY-MM-DDTHH:MM:SS.ffffffZ (microseconds), exactly as the SQL to_char does. */
  created_at: string;
  via_connector_id: string | null;
  external_event_id: string | null;
  external_actor_ref: string | null;
  chain_seq: number;
};

function byKey(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return ba.length - bb.length;
  return Buffer.compare(ba, bb);
}

/** jsonb::text for a JSON value. */
export function jsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byKey)
      .map((k) => `${JSON.stringify(k)}: ${jsonbText(o[k])}`)
      .join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function auditCanonical(r: AuditHashRow): string {
  return jsonbText([
    r.id, r.workspace_id, r.actor_type, r.actor_id, r.actor_label, r.principal_id, r.action,
    r.target_type, r.target_id, r.before, r.after, r.channel, r.request_id, r.created_at,
    r.via_connector_id, r.external_event_id, r.external_actor_ref, r.chain_seq,
  ]);
}

export function auditRowHash(prevHash: string | null, r: AuditHashRow): string {
  return createHash("sha256").update(`${prevHash ?? ""}|${auditCanonical(r)}`, "utf8").digest("hex");
}
