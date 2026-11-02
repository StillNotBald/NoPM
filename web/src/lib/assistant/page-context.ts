/**
 * Validate the page context the panel sends with a chat turn (A5).
 *
 * The client is untrusted: the path must look like an app path, the timezone
 * must be a real IANA zone, and a project id is only kept if that project is in
 * the caller's own workspace (its name then comes from the database, not the
 * client). Anything that fails is dropped silently; context is a hint, never a
 * reason to refuse a turn.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTimezone, type PageContext } from "@/lib/agent-core/system-prompt";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_RE = /^\/[A-Za-z0-9/_\-.]{0,199}$/;

export async function resolvePageContext(
  raw: unknown,
  workspaceId: string,
  db: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<PageContext | undefined> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PageContext = {};
  if (typeof r.path === "string" && PATH_RE.test(r.path)) out.path = r.path;
  if (isValidTimezone(r.tz)) out.tz = r.tz;
  if (typeof r.project_id === "string" && UUID_RE.test(r.project_id)) {
    try {
      const { data } = await db
        .from("projects")
        .select("id, name")
        .eq("id", r.project_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (data) {
        out.project_id = data.id as string;
        out.project_name = typeof data.name === "string" ? data.name : undefined;
      }
    } catch {
      /* context is best effort */
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
