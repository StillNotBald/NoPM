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

/** A short, secret-free message for a log line, a receipt or an audit row. */
export function safeAnchorError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const code = err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
  const text = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[host]")
    .replace(/\s+/g, " ")
    .trim();
  const out = code && !text.includes(code) ? `${code}: ${text}` : text;
  return (out || "unknown error").slice(0, 200);
}
