import { route } from "@/lib/api/handler";
import { okList } from "@/lib/api/response";
import { assertCanListMembers, listMembers } from "@/lib/people/members";

export const runtime = "nodejs";

// GET /api/members - everyone in the workspace with role, status and whether two-step is on.
// Admin or manager session only. Never returns secrets or backup codes.
export const GET = route(async ({ actor }) => {
  assertCanListMembers(actor);
  const rows = await listMembers(actor.workspaceId);
  return okList(rows, { total: rows.length, page: 1, limit: rows.length || 1 });
});
