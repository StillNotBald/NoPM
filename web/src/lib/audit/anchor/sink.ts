/**
 * The external anchor sink (R-168): a place the application can append the audit chain head to and
 * read it back from, that the primary database owner cannot rewrite. Pluggable on purpose: today
 * there is one real implementation (postgres-sink.ts, a second database reached by
 * NOPM_ANCHOR_DB_URL) and a no-op used when the variable is unset.
 *
 * Contract: no method ever throws. Every failure comes back as data so a business write, the
 * verify route and the cron tick can all carry on (fail-open for writes, loud for claims, D8).
 */
export type AnchorRecord = {
  workspace_id: string;
  /** The audit_log.chain_seq of the anchored row (per workspace, 1-based). */
  chain_seq: number;
  /** The row_hash of that row. */
  head_hash: string;
  /** Number of audit rows up to and including the anchored one (the chain is gapless, so = chain_seq). */
  row_count: number;
  /** ISO time the anchor was taken. */
  anchored_at: string;
  /** Where the row came from: 'nopm' (this app) or 'reset' (the owner re-baselined after a restore). */
  source?: string;
  /** Set by the sink on `latest`: when the baseline `reset` row this record follows was recorded, if any. */
  baseline_reset_at?: string | null;
};

export type PutResult =
  /** Written now, and read back from the sink with the same hash. */
  | { status: "stored"; record: AnchorRecord }
  /** A record for this (workspace, chain_seq) was already there with the SAME hash. */
  | { status: "exists"; record: AnchorRecord }
  /** A record for this (workspace, chain_seq) is already there with a DIFFERENT hash: the tamper case. */
  | { status: "conflict"; stored: AnchorRecord }
  /** The sink could not be reached, refused the write, or the read-back did not match. Nothing is anchored. */
  | { status: "failed"; error: string }
  /** No sink is configured (NOPM_ANCHOR_DB_URL unset). Nothing was written. */
  | { status: "disabled" };

export type LatestResult =
  | { ok: true; records: Map<string, AnchorRecord> }
  | { ok: false; error: string };

export interface AnchorSink {
  /** "none" when nothing is configured; every surface then says "not anchored". */
  readonly kind: "none" | "postgres" | (string & {});
  /** Append one record and read it back to confirm. Never throws. */
  put(record: AnchorRecord): Promise<PutResult>;
  /** The newest record (highest chain_seq) of each given workspace; workspaces never anchored are absent. Never throws. */
  latest(workspaceIds: readonly string[]): Promise<LatestResult>;
}

/** An error whose text we wrote ourselves and know holds no host, role or URL: passed through as is. */
export class AnchorSafeError extends Error {}

const PHRASES: Record<string, string> = {
  ENOTFOUND: "DNS lookup failed",
  EAI_AGAIN: "DNS lookup failed",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection reset",
  ETIMEDOUT: "timed out",
  EHOSTUNREACH: "host unreachable",
  ENETUNREACH: "network unreachable",
  "28P01": "login refused",
  "28000": "login refused",
  "3D000": "database not found",
  "42501": "permission denied",
  "42P01": "table missing",
  "57014": "statement timed out",
  "53300": "too many connections",
  DEPTH_ZERO_SELF_SIGNED_CERT: "certificate not trusted",
  SELF_SIGNED_CERT_IN_CHAIN: "certificate not trusted",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificate not trusted",
  CERT_HAS_EXPIRED: "certificate expired",
  ERR_TLS_CERT_ALTNAME_INVALID: "certificate name mismatch",
};

/**
 * A short message for a log line, a receipt or an audit row that can never hold a host name, role
 * name, address or URL: our own messages pass through, anything else is reduced to the error code
 * plus a fixed phrase (W2-06).
 */
export function safeAnchorError(err: unknown): string {
  if (err instanceof AnchorSafeError) return err.message.slice(0, 200);
  const code = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (code && PHRASES[code]) return `${code}: ${PHRASES[code]}`;
  if (/timeout|timed out/i.test(raw)) return "timed out";
  if (/ssl|tls|certificate/i.test(raw)) return "TLS problem";
  if (code && /^[A-Z0-9_]{3,40}$/.test(code)) return `${code}: connection or query error`;
  return "unexpected error";
}
