import { route } from "@/lib/api/handler";
import { RuleError, ScopeError } from "@/lib/api/errors";
import { created } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { mintLinkCode } from "@/lib/integrations/identity";
import { getActiveConnector, listConnectors } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/identities/link-code — mint a one-time link code
 * (`NPL-XXXX-XXXX`, 10 minutes, single use) for the SIGNED-IN member. They DM
 * `link <code>` to the bot; the bot event carries the platform-verified user
 * id, which is what binds the platform account to this profile. Never by email.
 *
 * Any signed-in member may link themselves (viewers included — the link grants
 * nothing by itself; approving still needs an admin/manager role at click
 * time). A session is required: a token actor has no profile to link. The code
 * is returned once and stored only as a hash; the audit row records that a
 * code was minted, never the code.
 */
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") throw new ScopeError("Linking an account requires a signed-in session");

  const connector = await getActiveConnector(actor.workspaceId);
  if (!connector) {
    // D-ACC-16: a PAUSED connector is not "no connector"; say what the admin has to do.
    const live = (await listConnectors(actor.workspaceId)).find((c) => c.kind === "lark" && c.status === "paused");
    if (live) {
      throw new RuleError("The Lark connection is paused. Ask an admin to resume it.", "connector_paused");
    }
    throw new RuleError("No active Lark connector in this workspace. Ask an admin to connect one.", "no_connector");
  }

  const { code, expiresAt } = await mintLinkCode({
    workspaceId: actor.workspaceId,
    profileId: actor.id,
    connectorId: connector.id,
  });

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.identity.code",
    targetType: "integration_connector",
    targetId: connector.id,
    before: null,
    after: { connector_id: connector.id, profile_id: actor.id, expires_at: expiresAt },
  });

  return created({
    code,
    expires_at: expiresAt,
    connector_id: connector.id,
    instructions: `Open a direct message with the bot and send: link ${code}`,
  });
});
