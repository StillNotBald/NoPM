import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reference numbers for the registers that carry a human-readable id
 * (CR-001, DEC-001, DOC-001). D9 / Q-GOV-16: a number is never reused.
 *
 * The old code took "highest number still on the table, plus one", so deleting
 * the newest record handed its number to the next one raised and an audit trail
 * that said "CR-007 was approved" could point at a different request. The number
 * now comes from a per-workspace counter (migration 0064, `nopm_next_ref`) that
 * only ever goes up. The counter is seeded from the highest number already in
 * the table, and an unique index (also 0064, when no duplicates exist) is the
 * last backstop; `insertWithReference` retries a unique violation with a fresh
 * number.
 */
export type RefKind = "change_request" | "decision" | "document";

const MAX_ATTEMPTS = 4;

export async function nextReference(db: SupabaseClient, workspaceId: string, kind: RefKind): Promise<string> {
  const { data, error } = await db.rpc("nopm_next_ref", { p_workspace_id: workspaceId, p_kind: kind });
  if (error || typeof data !== "string") {
    throw new Error(`Could not allocate a reference number: ${error?.message ?? "unexpected answer"}`);
  }
  return data;
}

// The untyped Supabase client answers `any` rows; keep that for the callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
type InsertResult = { data: Row | null; error: { code?: string; message: string } | null };

/**
 * Allocate a reference and run the insert with it; on a unique violation
 * (SQLSTATE 23505) take the next number and try again.
 */
export async function insertWithReference(
  db: SupabaseClient,
  workspaceId: string,
  kind: RefKind,
  insert: (referenceId: string) => PromiseLike<InsertResult>,
): Promise<InsertResult> {
  let last: InsertResult = { data: null, error: { message: "Insert failed" } };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ref = await nextReference(db, workspaceId, kind);
    last = await insert(ref);
    if (!last.error || last.error.code !== "23505") return last;
  }
  return last;
}
