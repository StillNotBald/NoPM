import type { AnchorRecord } from "./sink";

/**
 * Compare the live chain with the newest external anchor (R-169). Pure: the caller reads the anchor
 * from the anchor database and the live rows from audit_log; this decides the state.
 *
 *   not_anchored  nothing to compare with (variable unset, or this workspace never anchored)
 *   anchored      the live row at the anchored chain_seq has the anchored hash, and it is the head
 *   behind        same, but the live chain has grown by rows_behind rows since (informational)
 *   mismatch      the live head is BELOW the anchored chain_seq (newest rows deleted), or the live row
 *                 at the anchored chain_seq is missing or has a different hash (rewritten, or the
 *                 chain was deleted and regrew with different content)
 *   unreachable   the anchor database could not be read, so no comparison ran
 */
export type AnchorState = "not_anchored" | "anchored" | "behind" | "mismatch" | "unreachable";

export type AnchorStatus = {
  state: AnchorState;
  /** chain_seq of the newest anchor, or null. */
  chain_seq: number | null;
  anchored_at: string | null;
  row_count: number | null;
  /** Live rows added since the anchor (state behind), else null. */
  rows_behind: number | null;
  /** For mismatch and unreachable: when the current streak began, when known. */
  since: string | null;
  /** Short secret-free reason for mismatch and unreachable. */
  reason: string | null;
  /** When the owner last re-baselined this workspace's anchor after a restore (a `reset` row), or null. */
  reset_at: string | null;
};

export const NOT_ANCHORED: AnchorStatus = {
  state: "not_anchored",
  chain_seq: null,
  anchored_at: null,
  row_count: null,
  rows_behind: null,
  since: null,
  reason: null,
  reset_at: null,
};

export type LiveChain = {
  /** chain_seq of the newest live audit row, null when the workspace has none. */
  headSeq: number | null;
  /** The live row_hash at the anchored chain_seq, null when that row does not exist. */
  hashAtAnchorSeq: string | null;
};

export function compareAnchor(anchor: AnchorRecord | null, live: LiveChain): AnchorStatus {
  if (!anchor) return { ...NOT_ANCHORED };
  const base = {
    chain_seq: anchor.chain_seq,
    anchored_at: anchor.anchored_at,
    row_count: anchor.row_count,
    rows_behind: null,
    since: null,
    reset_at: anchor.baseline_reset_at ?? null,
  };
  if (live.headSeq === null || live.headSeq < anchor.chain_seq) {
    return {
      ...base,
      state: "mismatch",
      reason: `the live chain ends at ${live.headSeq ?? 0}, below the anchored row ${anchor.chain_seq}: rows were removed`,
    };
  }
  if (live.hashAtAnchorSeq === null) {
    return { ...base, state: "mismatch", reason: `the live row ${anchor.chain_seq} is missing` };
  }
  if (live.hashAtAnchorSeq !== anchor.head_hash) {
    return { ...base, state: "mismatch", reason: `the live row ${anchor.chain_seq} has a different hash from the anchor` };
  }
  if (live.headSeq === anchor.chain_seq) return { ...base, state: "anchored", reason: null };
  return { ...base, state: "behind", rows_behind: live.headSeq - anchor.chain_seq, reason: null };
}

export function unreachableStatus(reason: string, since: string | null = null, last: AnchorStatus | null = null): AnchorStatus {
  return {
    state: "unreachable",
    chain_seq: last?.chain_seq ?? null,
    anchored_at: last?.anchored_at ?? null,
    row_count: last?.row_count ?? null,
    rows_behind: null,
    since,
    reason,
    reset_at: null,
  };
}
