import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET } from "@/lib/documents/storage";

/**
 * Remove the stored files of a deleted project's documents (owner decision 20,
 * 2026-10-17: "stored files of deleted documents are removed after commit").
 *
 * The commit RPC (nopm_commit_project_deletion, 0076) returns the `document_paths`
 * it read BEFORE the cascade removed the document rows. This runs AFTER the
 * commit, so a failure here can leave an unreferenced object but never a record
 * pointing at a missing file; the cascade audit rows (`document.cascade_delete`)
 * carry every path, so a leftover can be traced and removed by hand. It never
 * throws: the deletion and its audit rows are already committed.
 *
 * Only paths inside the actor's own workspace folder (`<workspaceId>/...`) are
 * removed, whatever the database returned.
 */
export async function removeStoredFiles(paths: unknown, workspaceId: string): Promise<void> {
  if (!Array.isArray(paths)) return;
  const own = paths.filter(
    (p): p is string => typeof p === "string" && p.startsWith(`${workspaceId}/`) && !p.includes(".."),
  );
  if (own.length === 0) return;
  try {
    const storage = createAdminClient().storage.from(BUCKET);
    for (let i = 0; i < own.length; i += 100) {
      const chunk = own.slice(i, i + 100);
      const { error } = await storage.remove(chunk);
      if (error) {
        console.error("[governance] project deleted but its stored files could not be removed", {
          paths: chunk,
          message: error.message,
        });
      }
    }
  } catch (err) {
    console.error("[governance] project deleted but its stored files could not be removed", err);
  }
}
