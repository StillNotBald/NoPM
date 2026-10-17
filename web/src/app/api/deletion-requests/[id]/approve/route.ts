import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { approveDeletion } from "@/lib/governance/decide";
import { z } from "zod";

export const runtime = "nodejs";

const ApproveSchema = z.object({
  note: z.string().max(1000).optional().nullable(),
});

/**
 * POST /api/deletion-requests/[id]/approve
 * Four-eyes checker step: approve and immediately commit the deletion.
 * Requires the scope matching the request's target type — task:delete:approve
 * for tasks, project:delete:approve for projects (per-type gate, resolved
 * AFTER loading the request; a wrong-type approver gets 403, not a commit).
 * Wildcard scopes (`*`, `task:*`) never grant these — see PRIVILEGED_SCOPES.
 *
 * Optional body `{ note }` (UC-12): the approver's note, recorded in the
 * audit row of the governance step instead of being silently dropped.
 *
 * Thin wrapper: the whole decision — per-type scope, the principal-aware
 * four-eyes check (the approver must be a different HUMAN from the requester,
 * and a token with no recorded owner can't approve), dispatch to the matching
 * atomic commit RPC, notification and the integration event — lives in
 * @/lib/governance/decide so the console, CLI, MCP and chat connectors all run
 * one code path. The delete + request-commit + BOTH audit rows run inside ONE
 * Postgres transaction in the RPC (nopm_commit_task_deletion / migration 0020,
 * nopm_commit_project_deletion / 0032, principal-aware since 0045), with the
 * request row locked FOR UPDATE there.
 *
 * If the target's project was locked after the deletion was requested, the
 * DB-level lock backstop raises PROJECT_LOCKED (errcode P0010) inside the same
 * transaction and the whole commit rolls back — a 422. Deliberately no bypass.
 */
export const POST = route(async ({ actor, params, request }) => {
  const body = await safeJson(request);
  const parsed = ApproveSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  await approveDeletion(actor, params.id, { note: parsed.data.note });

  return ok({ committed: true });
});
