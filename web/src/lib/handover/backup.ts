import { FieldsError } from "@/lib/api/errors";

/**
 * M6: a backup is only a backup if it is somebody else. The database has a CHECK
 * for this too (0095); this returns the 422 before the write instead of a 500.
 * A null on either side passes: an unset owner or backup is a finding for the
 * handover report, not a write error.
 */
export function assertBackupDiffers(
  primaryId: string | null | undefined,
  backupId: string | null | undefined,
  backupField: string,
  primaryField: string,
): void {
  if (primaryId && backupId && primaryId.toLowerCase() === backupId.toLowerCase()) {
    const message = `${backupField} must be a different person from ${primaryField}`;
    throw new FieldsError(message, [{ field: backupField, message }]);
  }
}

/**
 * Task version (wave-3 review F25). A task backup is a resource member, and two
 * members can be linked to the same login, which would make one person their own
 * backup. Compares the ids first, then the linked logins when both members have one.
 */
export async function assertTaskBackupDiffers(
  db: { from(table: string): any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  workspaceId: string,
  assigneeId: string | null | undefined,
  backupId: string | null | undefined,
): Promise<void> {
  assertBackupDiffers(assigneeId, backupId, "backup_assignee_id", "assignee_id");
  if (!assigneeId || !backupId) return;
  const { data } = await db
    .from("resource_members")
    .select("id, profile_id")
    .eq("workspace_id", workspaceId)
    .in("id", [assigneeId, backupId]);
  const rows = (data ?? []) as Array<{ id: string; profile_id: string | null }>;
  const a = rows.find((r) => r.id.toLowerCase() === assigneeId.toLowerCase())?.profile_id;
  const b = rows.find((r) => r.id.toLowerCase() === backupId.toLowerCase())?.profile_id;
  assertBackupDiffers(a, b, "backup_assignee_id", "assignee_id");
}

/** Effective value after a PATCH: the patch value when sent (even null), else what is stored. */
export function effective<T>(patch: T | undefined, stored: T | null | undefined): T | null {
  return patch !== undefined ? patch : (stored ?? null);
}
