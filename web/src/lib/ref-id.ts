import type { SupabaseClient } from "@supabase/supabase-js";

type RegisterTable = "risks" | "issues" | "clashes";

/**
 * Compute the next sequential reference_id for a workspace + register table.
 *
 * Strategy: fetch all existing reference_id values for the workspace, parse the
 * numeric suffix (e.g. "R-042" → 42), take the max, add 1, and zero-pad to 3
 * digits.  Falls back to COUNT+1 when no parseable IDs exist (brand-new
 * workspace).  All reads go through the admin client (RLS bypassed) so this
 * works for both session and PAT callers.
 *
 * @param db          Service-role Supabase client
 * @param workspaceId UUID of the workspace
 * @param table       One of "risks" | "issues" | "clashes"
 * @param prefix      e.g. "R", "ISS", "CL"
 * @returns           e.g. "R-001", "ISS-042"
 */
export async function nextRefId(
  db: SupabaseClient,
  workspaceId: string,
  table: RegisterTable,
  prefix: string,
): Promise<string> {
  // Fetch existing reference_ids so we can derive the next number.
  const { data, error } = await db
    .from(table)
    .select("reference_id")
    .eq("workspace_id", workspaceId)
    .not("reference_id", "is", null);

  if (error) throw new Error(`nextRefId: failed to read ${table}: ${error.message}`);

  let maxNum = 0;

  if (data && data.length > 0) {
    for (const row of data) {
      const val = row.reference_id as string | null;
      if (!val) continue;
      // Accept "PREFIX-NNN" or any suffix after the last "-"
      const dashIdx = val.lastIndexOf("-");
      if (dashIdx === -1) continue;
      const num = parseInt(val.slice(dashIdx + 1), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
    // If we couldn't parse any suffix, fall back to total row count
    if (maxNum === 0) maxNum = data.length;
  }

  const next = maxNum + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}
