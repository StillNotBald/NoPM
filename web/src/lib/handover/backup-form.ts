export type BackupEntity = "projects" | "risks" | "issues" | "tasks";

/**
 * Request-body fields for the backup picker.
 *
 * A create sends the field only when a backup was chosen. An edit sends it only when
 * the person changed the picker (even back to "No backup", which sends null). An edit
 * that never touched it sends nothing, so a form that did not load the stored
 * backup can never clear it.
 */
export function backupPayload(
  entity: BackupEntity,
  value: string,
  touched: boolean,
  editing: boolean,
): Record<string, string | null> {
  const field = entity === "tasks" ? "backup_assignee_id" : "backup_owner_id";
  if (editing) return touched ? { [field]: value || null } : {};
  return value ? { [field]: value } : {};
}
