import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * audit_anchor_receipts (migration 0112): the last anchor this app recorded per workspace plus the
 * current failure streak. Display and streak bookkeeping ONLY. It is never read to decide a
 * comparison (the anchor database is the evidence), so a stale or edited row cannot hide a mismatch.
 *
 * This file holds the direct writes and no audit call, on purpose: the audit rows that go with a
 * state change are written by anchor.ts BEFORE it calls saveReceipt, so a streak is remembered only
 * once its audit row exists (atomicity-scan sees no write-then-audit order).
 */
export type Db = ReturnType<typeof createAdminClient>;

export type ReceiptStatus = "anchored" | "failed" | "mismatch";

export type Receipt = {
  workspace_id: string;
  status: ReceiptStatus;
  chain_seq: number | null;
  head_hash: string | null;
  row_count: number | null;
  anchored_at: string | null;
  error_text: string | null;
  streak_started_at: string | null;
};

const COLUMNS = "workspace_id, status, chain_seq, head_hash, row_count, anchored_at, error_text, streak_started_at";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The receipt of a workspace, or null when there is none or it cannot be read (older schema). Never throws. */
export async function getReceipt(db: Db, workspaceId: string): Promise<Receipt | null> {
  try {
    const { data, error } = await db.from("audit_anchor_receipts").select(COLUMNS).eq("workspace_id", workspaceId).maybeSingle();
    if (error || !data) return null;
    const r = data as Record<string, unknown>;
    return {
      workspace_id: String(r.workspace_id),
      status: r.status as ReceiptStatus,
      chain_seq: num(r.chain_seq),
      head_hash: (r.head_hash as string | null) ?? null,
      row_count: num(r.row_count),
      anchored_at: (r.anchored_at as string | null) ?? null,
      error_text: (r.error_text as string | null) ?? null,
      streak_started_at: (r.streak_started_at as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** Upsert the given columns only (the others keep their value). True when the write succeeded. Never throws. */
export async function saveReceipt(db: Db, workspaceId: string, patch: Partial<Omit<Receipt, "workspace_id">>): Promise<boolean> {
  try {
    const { error } = await db
      .from("audit_anchor_receipts")
      .upsert({ workspace_id: workspaceId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "workspace_id" });
    if (error) {
      console.error("[anchor] receipt write failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[anchor] receipt write failed:", err instanceof Error ? err.message : "unknown error");
    return false;
  }
}
