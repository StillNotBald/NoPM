import { route } from "@/lib/api/handler";
import { requestDeletion } from "@/lib/governance/request-deletion";

export const runtime = "nodejs";

/**
 * DELETE /api/expenses/:id — does NOT delete the expense. An expense is a money record, so it raises a
 * deletion request (scope expense:delete:request) with a required `reason` and returns 202. A second person
 * approves it at POST /api/deletion-requests/:id/approve (audit gap G8; the database refuses any other DELETE).
 */
export const DELETE = route(async ({ actor, params, request }) =>
  requestDeletion({ actor, request, entity: "expense", id: params.id }),
);
