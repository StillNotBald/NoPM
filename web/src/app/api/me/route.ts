import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

export const GET = route(async ({ actor }) => {
  return ok({
    type: actor.type,
    id: actor.id,
    label: actor.label,
    workspaceId: actor.workspaceId,
    role: actor.role ?? null,
    scopes: actor.scopes ?? null,
  });
});
