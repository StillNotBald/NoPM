import type { SupabaseClient } from "@supabase/supabase-js";
import { FieldsError } from "@/lib/api/errors";

/**
 * Cross-tenant reference guard.
 *
 * Token callers (and every route in this app) use the service-role client, so
 * RLS never sees a write. A body field that points at another row (owner_id,
 * assignee_id, supersedes, blocked_by, project_id, ...) is therefore only as
 * safe as the route's own check — and the foreign keys in the schema are plain
 * `references table(id)`, which are satisfied by a row in ANY workspace. An
 * unchecked id was accepted, and the damage crossed tenants: a W1 project owned
 * by a W2 user pushed W1-authored notification text into the W2 user's bell,
 * and a W1 decision that `supersedes` a W2 decision made W2's own delete of it
 * fail (500) because of the NO ACTION foreign key.
 *
 * `assertRefsInWorkspace` is the one place that closes this. Every create /
 * update route lists the ids it is about to write and the table each one must
 * live in; we resolve them with ONE query per table (batched, filtered by
 * `workspace_id`) and throw a 422 `{ error, code: "invalid_reference", fields }`
 * naming every offending field.
 *
 * Rules:
 *  - `null` / `undefined` ids are skipped: clearing a reference (`owner_id:
 *    null`) or not sending one is always allowed.
 *  - A non-UUID string is a field error, never forwarded to PostgREST.
 *  - "Does not exist" and "exists in another workspace" produce the SAME
 *    message, so the response is not an existence oracle for foreign ids.
 *  - A failed lookup throws (fail closed) — we never write on an unverified id.
 *
 * This is the API-layer check. The database-level backstop (composite
 * `(workspace_id, id)` foreign keys) is a separate migration.
 */

/** Tables whose rows carry a `workspace_id` and may be referenced from a body field. */
export const REF_TABLES = [
  "profiles",
  "resource_members",
  "projects",
  "milestones",
  "tasks",
  "programs",
  "sprints",
  "decisions",
  "documents",
  "risks",
  "issues",
  "change_requests",
  "clashes",
] as const;

export type RefTable = (typeof REF_TABLES)[number];

export type WorkspaceRef = {
  /** Table the id must live in. */
  table: RefTable;
  /** The id from the request body. null / undefined = nothing to check. */
  id: string | null | undefined;
  /** Body field name — reported in the 422 `fields` list. */
  field: string;
  /**
   * Extra equality constraints the referenced row must also satisfy, e.g.
   * `{ project_id }` to require that a milestone belongs to the same project.
   * Refs with different constraints are queried separately.
   */
  match?: Record<string, string>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Group = {
  table: RefTable;
  match: Record<string, string>;
  ids: Set<string>;
  found: Set<string>;
};

/**
 * Verify that every referenced row exists in `workspaceId`. Resolves when all
 * refs are fine (or there is nothing to check); throws `FieldsError` (422)
 * otherwise. Pass the admin client from the route.
 */
export async function assertRefsInWorkspace(
  db: SupabaseClient,
  workspaceId: string,
  refs: readonly WorkspaceRef[],
): Promise<void> {
  const failures: { field: string; message: string }[] = [];
  const groups = new Map<string, Group>();
  const pending: { ref: WorkspaceRef; id: string; group: Group }[] = [];

  for (const ref of refs) {
    if (ref.id === null || ref.id === undefined) continue;
    if (typeof ref.id !== "string" || !UUID_RE.test(ref.id)) {
      failures.push({ field: ref.field, message: `${ref.field} must be a valid UUID` });
      continue;
    }
    const id = ref.id.toLowerCase();
    const match = ref.match ?? {};
    const key = `${ref.table}|${JSON.stringify(Object.entries(match).sort(([a], [b]) => a.localeCompare(b)))}`;
    let group = groups.get(key);
    if (!group) {
      group = { table: ref.table, match, ids: new Set(), found: new Set() };
      groups.set(key, group);
    }
    group.ids.add(id);
    pending.push({ ref, id, group });
  }

  // One query per (table, constraints) group, concurrently.
  await Promise.all(
    [...groups.values()].map(async (group) => {
      let query = db
        .from(group.table)
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("id", [...group.ids]);
      for (const [column, value] of Object.entries(group.match)) {
        query = query.eq(column, value);
      }
      const { data, error } = await query;
      if (error) throw new Error(`workspace-refs: ${group.table} lookup failed: ${error.message}`);
      for (const row of (data ?? []) as { id: string }[]) group.found.add(String(row.id).toLowerCase());
    }),
  );

  for (const { ref, id, group } of pending) {
    if (!group.found.has(id)) {
      failures.push({ field: ref.field, message: `${ref.field} was not found in this workspace` });
    }
  }

  if (failures.length > 0) {
    throw new FieldsError("Referenced record not found in this workspace", failures, "invalid_reference");
  }
}
