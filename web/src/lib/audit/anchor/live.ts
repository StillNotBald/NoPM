import type { Db } from "./receipts";

/** Reads of the LIVE audit chain used by the anchor comparison. These throw on a database error (the caller decides). */
export type LiveHead = { seq: number; hash: string };

export async function readLiveHead(db: Db, workspaceId: string): Promise<LiveHead | null> {
  const { data, error } = await db
    .from("audit_log")
    .select("chain_seq, row_hash")
    .eq("workspace_id", workspaceId)
    .not("chain_seq", "is", null)
    .order("chain_seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`audit head read failed: ${error.message}`);
  const r = data as { chain_seq?: unknown; row_hash?: unknown } | null;
  if (!r || r.chain_seq == null || typeof r.row_hash !== "string") return null;
  return { seq: Number(r.chain_seq), hash: r.row_hash };
}

/** The live row_hash at one chain_seq, or null when that row does not exist. */
export async function readLiveHashAt(db: Db, workspaceId: string, seq: number): Promise<string | null> {
  const { data, error } = await db
    .from("audit_log")
    .select("row_hash")
    .eq("workspace_id", workspaceId)
    .eq("chain_seq", seq)
    .maybeSingle();
  if (error) throw new Error(`audit row read failed: ${error.message}`);
  const h = (data as { row_hash?: unknown } | null)?.row_hash;
  return typeof h === "string" ? h : null;
}
