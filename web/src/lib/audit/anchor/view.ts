import type { AnchorState, AnchorStatus } from "./compare";
import type { Receipt } from "./receipts";

/**
 * What the Trust Center needs to draw the anchor: the same object GET /api/audit/verify returns under
 * `anchor`. Client-safe (types only plus pure functions, no database or pg import).
 */
export type AnchorView = Pick<AnchorStatus, "state" | "chain_seq" | "anchored_at" | "row_count" | "rows_behind" | "since">;

export const NOT_ANCHORED_VIEW: AnchorView = {
  state: "not_anchored",
  chain_seq: null,
  anchored_at: null,
  row_count: null,
  rows_behind: null,
  since: null,
};

const STATES: readonly AnchorState[] = ["not_anchored", "anchored", "behind", "mismatch", "unreachable"];

/** Coerce an unknown JSON value (a verify response, an event detail) into a view, or null. */
export function toAnchorView(raw: unknown): AnchorView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || !STATES.includes(r.state as AnchorState)) return null;
  const n = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    state: r.state as AnchorState,
    chain_seq: n(r.chain_seq),
    anchored_at: s(r.anchored_at),
    row_count: n(r.row_count),
    rows_behind: n(r.rows_behind),
    since: s(r.since),
  };
}

/**
 * The display state from the primary-side receipt (migration 0112) for the first paint of the Trust
 * Center. With the sink unconfigured it is ALWAYS "not anchored", whatever an old receipt says, so
 * the page, the API and the audit pack agree. A receipt is display only; the verify route compares
 * against the anchor database itself.
 */
export function receiptToView(receipt: Pick<Receipt, "status" | "chain_seq" | "anchored_at" | "row_count" | "streak_started_at"> | null, configured: boolean): AnchorView {
  if (!configured || !receipt) return { ...NOT_ANCHORED_VIEW };
  const base = { chain_seq: receipt.chain_seq, anchored_at: receipt.anchored_at, row_count: receipt.row_count, rows_behind: null };
  if (receipt.status === "mismatch") return { ...base, state: "mismatch", since: receipt.streak_started_at };
  if (receipt.status === "failed") return { ...base, state: "unreachable", since: receipt.streak_started_at };
  return receipt.chain_seq === null ? { ...NOT_ANCHORED_VIEW } : { ...base, state: "anchored", since: null };
}
