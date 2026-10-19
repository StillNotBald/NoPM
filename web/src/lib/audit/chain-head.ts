import type { AnchorStatus } from "@/lib/audit/anchor/compare";

/**
 * The newest audit row_hash of a workspace (migration 0104). Printed on the weekly report and the
 * audit pack cover so a person keeps a copy outside the database: deleting the newest audit rows
 * leaves a valid chain, and is only detectable against a head hash recorded earlier.
 * Fail-soft: an older schema (no row_hash yet), an empty log or a read error gives null and the
 * document simply omits the line.
 */
export type ChainHead = { hash: string; at: string };

type HeadQuery = PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> & {
  select(columns: string): HeadQuery;
  eq(column: string, value: unknown): HeadQuery;
  order(column: string, opts?: { ascending?: boolean }): HeadQuery;
  range(from: number, to: number): HeadQuery;
};

export async function getChainHead(db: { from(table: string): unknown }, workspaceId: string): Promise<ChainHead | null> {
  try {
    const q = (db.from("audit_log") as HeadQuery)
      .select("row_hash, created_at")
      .eq("workspace_id", workspaceId)
      .order("chain_seq", { ascending: false })
      .range(0, 0);
    const { data, error } = await q;
    const row = (data ?? [])[0] as { row_hash?: unknown; created_at?: unknown } | undefined;
    if (error || !row || typeof row.row_hash !== "string" || typeof row.created_at !== "string") return null;
    return { hash: row.row_hash, at: row.created_at };
  } catch {
    return null;
  }
}

/** "Audit chain head: <hash> at <UTC time>" for a document, or null when there is no head. */
export function chainHeadLine(head: ChainHead | null | undefined): string | null {
  if (!head) return null;
  return `Audit chain head: ${head.hash} at ${head.at.slice(0, 19).replace("T", " ")} UTC`;
}

const utc = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

/**
 * One line for the audit pack cover (R-169f): "Anchor: not anchored", "Anchor: anchored <time> (n rows)",
 * "Anchor: anchored <time> (n rows), N rows behind", "Anchor: MISMATCH ..." or "Anchor: unreachable".
 * A missing status reads as not anchored (the variable is unset or the schema is older).
 */
export function anchorLine(a: AnchorStatus | null | undefined): string {
  if (!a || a.state === "not_anchored") return "Anchor: not anchored";
  const when = a.anchored_at ? utc(a.anchored_at) : "unknown time";
  const rows = a.row_count != null ? ` (${a.row_count.toLocaleString("en-GB")} rows)` : "";
  switch (a.state) {
    case "anchored":
      return `Anchor: anchored ${when}${rows}`;
    case "behind":
      return `Anchor: anchored ${when}${rows}, ${a.rows_behind ?? 0} rows behind`;
    case "mismatch":
      return `Anchor: MISMATCH with the external anchor of ${when}${rows}`;
    default:
      return "Anchor: unreachable, not compared";
  }
}
