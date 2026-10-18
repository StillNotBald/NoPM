import type { SupabaseClient } from "@supabase/supabase-js";
import { appBaseUrl } from "@/lib/integrations/store";

/**
 * GitHub connector persistence + presentation (R-153). The connector is an `integration_connectors` row
 * of kind 'github'; every query filters workspace_id (service-role client, RLS bypassed). The raw row
 * carries `secret_enc` and must never leave the server: `toPublicGithubConnector` is what an API returns.
 */

export const GITHUB_CONNECTOR_COLUMNS =
  "id, workspace_id, kind, name, status, config, secret_enc, created_by, created_at, updated_at, revoked_at" as const;

export type GithubConnectorRow = {
  id: string;
  workspace_id: string;
  kind: "github";
  name: string;
  status: "active" | "paused" | "revoked";
  config: Record<string, unknown>;
  secret_enc: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export async function getGithubConnectorById(db: SupabaseClient, id: string): Promise<GithubConnectorRow | null> {
  const { data, error } = await db
    .from("integration_connectors")
    .select(GITHUB_CONNECTOR_COLUMNS)
    .eq("id", id)
    .eq("kind", "github")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GithubConnectorRow | null) ?? null;
}

/** The workspace's live (active or paused) GitHub connector, or null. */
export async function getLiveGithubConnector(db: SupabaseClient, workspaceId: string): Promise<GithubConnectorRow | null> {
  const { data, error } = await db
    .from("integration_connectors")
    .select(GITHUB_CONNECTOR_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("kind", "github")
    .neq("status", "revoked")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as GithubConnectorRow | null) ?? null;
}

export function githubWebhookUrl(base: string, connectorId: string): string {
  return `${base}/api/integrations/github/${connectorId}/events`;
}

export type PublicGithubConnector = {
  id: string;
  name: string;
  status: GithubConnectorRow["status"];
  webhook_url: string;
  created_at: string;
  updated_at: string;
};

export function toPublicGithubConnector(row: GithubConnectorRow, requestOrigin?: string | null): PublicGithubConnector {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    webhook_url: githubWebhookUrl(appBaseUrl(requestOrigin), row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
