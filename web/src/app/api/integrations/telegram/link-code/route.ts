import { route } from "@/lib/api/handler";
import { RuleError, ScopeError } from "@/lib/api/errors";
import { created } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { mintLinkCode } from "@/lib/integrations/identity";
import { getLiveTelegramConnector } from "@/lib/integrations/telegram/store";
import { normalizeConfig } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/telegram/link-code - mint a one-time link code
 * (`NPL-XXXX-XXXX`, 10 minutes, single use; a new code replaces the earlier
 * unused one) for the SIGNED-IN member, plus the t.me deep link that sends it to
 * the bot as `/start CODE`. Same mechanism and limits as the Lark link code: the
 * code is returned once, stored only as a hash, and the audit row records that a
 * code was minted, never the code. Session only (a token has no profile to link).
 */
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") throw new ScopeError("Linking an account requires a signed-in session");

  const connector = await getLiveTelegramConnector(actor.workspaceId);
  if (!connector) throw new RuleError("No Telegram bot is connected in this workspace. Ask an admin to connect one.", "no_connector");
  if (connector.status !== "active") throw new RuleError("The Telegram bot is paused. Ask an admin to resume it.", "connector_paused");

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

  const bot = normalizeConfig(connector.config).appId;
  return created({
    code,
    expires_at: expiresAt,
    connector_id: connector.id,
    bot_username: bot,
    deep_link: bot ? `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(code)}` : null,
    instructions: `Open a private chat with the bot and send: /start ${code}`,
  });
});
