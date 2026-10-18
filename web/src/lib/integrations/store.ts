import { createAdminClient } from "@/lib/supabase/admin";
import { ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";
import { decryptSecrets, secretsView, type SecretsView } from "@/lib/integrations/secrets";
import type { ConnectorRow, ConnectorStatus, LarkConfig, LarkSecrets } from "@/lib/integrations/types";

/**
 * Persistence + presentation helpers for integration_connectors.
 *
 * Every query filters `workspace_id` (service-role client, RLS bypassed). The
 * raw `ConnectorRow` carries `secret_enc` and `relay_secret_hash` and must
 * never leave the server; anything that reaches an API response goes through
 * `toPublicConnector`, which exposes presence booleans and non-secret config
 * only.
 */

export const CONNECTOR_COLUMNS =
  "id, workspace_id, kind, name, status, config, secret_enc, relay_secret_hash, tenant_key, created_by, created_at, updated_at, revoked_at" as const;

/** Shown to a platform user whose tenant is not the one this connector is pinned to. */
export const TENANT_MISMATCH_MESSAGE = "This Lark workspace is not the one connected to NoPM";

/**
 * True when the connector is pinned to a tenant and the event came from another.
 * An unpinned connector accepts any tenant until the first identity link pins it.
 */
export function tenantMismatch(connector: Pick<ConnectorRow, "tenant_key">, externalTenant: string): boolean {
  return !!connector.tenant_key && connector.tenant_key !== externalTenant;
}

/** Connector management is a workspace-admin, signed-in-user action (never a token). */
export function assertIntegrationAdmin(actor: Actor): void {
  if (actor.type !== "user" || actor.role !== "admin") {
    throw new ScopeError("Integration management requires an admin session");
  }
}

export function isIntegrationAdmin(actor: Actor): boolean {
  return actor.type === "user" && actor.role === "admin";
}

/**
 * Normalise a stored `config` jsonb into a complete LarkConfig. The column is
 * free-form jsonb, so never trust its shape: fill defaults rather than let a
 * missing key crash a delivery drain.
 */
export function normalizeConfig(raw: unknown): LarkConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const approvals = (c.approvals && typeof c.approvals === "object" ? c.approvals : {}) as Record<string, unknown>;
  const digest = (c.digest && typeof c.digest === "object" ? c.digest : {}) as Record<string, unknown>;
  const weekday = typeof digest.weekday === "number" && digest.weekday >= 0 && digest.weekday <= 6 ? digest.weekday : 1;
  return {
    region: c.region === "feishu" ? "feishu" : "lark",
    appId: typeof c.appId === "string" ? c.appId : "",
    mode: c.mode === "long_connection" ? "long_connection" : "webhook",
    approvals: { enabled: approvals.enabled !== false },
    digest: {
      enabled: digest.enabled === true,
      chatId: typeof digest.chatId === "string" && digest.chatId ? digest.chatId : null,
      weekday,
    },
  };
}

function hydrate(row: Record<string, unknown>): ConnectorRow {
  return { ...(row as unknown as ConnectorRow), config: normalizeConfig(row.config) };
}

export async function getConnector(workspaceId: string, id: string): Promise<ConnectorRow | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data as Record<string, unknown>) : null;
}

/** The workspace's active connector of a kind (there is at most one live per kind). */
export async function getActiveConnector(workspaceId: string, kind: ConnectorRow["kind"] = "lark"): Promise<ConnectorRow | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", kind)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data ? hydrate(data as Record<string, unknown>) : null;
}

export async function listConnectors(workspaceId: string): Promise<ConnectorRow[]> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(hydrate);
}

/** Decrypt a connector's secrets. Throws on a missing/rotated key or corrupt blob. */
export function loadConnectorSecrets(connector: Pick<ConnectorRow, "secret_enc">): LarkSecrets {
  return decryptSecrets(connector.secret_enc);
}

/** The shape an API may return for a connector: no ciphertext, no hash, no values. */
export type PublicConnector = SecretsView & {
  id: string;
  kind: ConnectorRow["kind"];
  name: string;
  status: ConnectorStatus;
  region: LarkConfig["region"];
  app_id: string;
  mode: LarkConfig["mode"];
  approvals: { enabled: boolean };
  digest: { enabled: boolean; chat_id: string | null; weekday: number };
  has_relay_secret: boolean;
  /** Whether the first identity link has pinned the connector to a platform tenant. */
  tenant_pinned: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

/**
 * What a non-admin member may see: that a connector exists and what it does —
 * nothing that identifies the platform app (no app id, chat id or weekday), no
 * secrets and no callback URLs.
 */
export type RedactedConnector = {
  id: string;
  kind: ConnectorRow["kind"];
  name: string;
  status: ConnectorStatus;
  region: LarkConfig["region"];
  mode: LarkConfig["mode"];
  approvals: { enabled: boolean };
  digest: { enabled: boolean };
};

export function toRedactedConnector(row: ConnectorRow): RedactedConnector {
  const cfg = normalizeConfig(row.config);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    region: cfg.region,
    mode: cfg.mode,
    approvals: { enabled: cfg.approvals.enabled },
    digest: { enabled: cfg.digest.enabled },
  };
}

/** Mask a platform id for display or audit: enough to recognise, not enough to reuse. */
export function maskExternalId(id: string): string {
  return id.length <= 10 ? `${id.slice(0, 2)}…` : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * The connector as it is written to an audit row's `before` / `after`. The
 * audit stream is readable by every workspace member, and the console hides the
 * app id, the group chat id and the tenant pin from non-admins (see
 * `toRedactedConnector`), so the audit trail must not hand them back: ids are
 * masked (enough to see THAT they changed), the tenant is reduced to the
 * `tenant_pinned` flag, and nothing secret is ever in the view to begin with.
 */
export function toAuditConnector(view: PublicConnector): Omit<PublicConnector, "app_id" | "digest"> & {
  app_id: string;
  digest: { enabled: boolean; chat_id: string | null; weekday: number };
} {
  return {
    ...view,
    app_id: view.app_id ? maskExternalId(view.app_id) : view.app_id,
    digest: { ...view.digest, chat_id: view.digest.chat_id ? maskExternalId(view.digest.chat_id) : null },
  };
}

/** The three non-secret URLs an admin pastes into the Lark developer console. */
export function callbackUrls(base: string, connectorId: string) {
  return {
    events: `${base}/api/integrations/lark/${connectorId}/events`,
    card: `${base}/api/integrations/lark/${connectorId}/card`,
    relay: `${base}/api/integrations/lark/${connectorId}/relay`,
  };
}

export function toPublicConnector(row: ConnectorRow): PublicConnector {
  const cfg = normalizeConfig(row.config);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    region: cfg.region,
    app_id: cfg.appId,
    mode: cfg.mode,
    approvals: { enabled: cfg.approvals.enabled },
    digest: { enabled: cfg.digest.enabled, chat_id: cfg.digest.chatId, weekday: cfg.digest.weekday },
    ...secretsView(row.secret_enc),
    has_relay_secret: !!row.relay_secret_hash,
    tenant_pinned: !!row.tenant_key,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at,
  };
}


/**
 * Public origin for deep links inside chat cards. Precedence:
 * `NEXT_PUBLIC_APP_URL` (a self-hosted instance must never link to someone
 * else's domain) > the request origin when one is known > Vercel's production
 * host (`VERCEL_PROJECT_PRODUCTION_URL`, set by the platform, no scheme) >
 * empty, in which case adapters render a card without a link.
 */
export function appBaseUrl(requestOrigin?: string | null): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const base = configured || requestOrigin || (vercelHost ? `https://${vercelHost}` : "");
  return base.replace(/\/+$/, "");
}
