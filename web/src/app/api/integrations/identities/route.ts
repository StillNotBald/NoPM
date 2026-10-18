import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { okList } from "@/lib/api/response";
import { listIdentities } from "@/lib/integrations/identity";
import { isIntegrationAdmin } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * GET /api/integrations/identities — linked platform accounts (active links
 * only). A member sees their own; a workspace admin sees everyone's, or just
 * their own with `?mine=1`. Platform ids are returned masked (a hint to
 * recognise the account, not a reusable id). Session callers only — a token
 * has no profile to link.
 */
export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") throw new ScopeError("Linked accounts are available to signed-in users");

  const mine = new URL(request.url).searchParams.get("mine") === "1";
  const everyone = isIntegrationAdmin(actor) && !mine;
  const items = await listIdentities({
    workspaceId: actor.workspaceId,
    ...(everyone ? {} : { profileId: actor.id }),
  });
  return okList(items, { total: items.length, page: 1, limit: Math.max(items.length, 1) });
});
