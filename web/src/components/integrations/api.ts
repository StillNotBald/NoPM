/**
 * Integrations console — every network call the page makes, in one place.
 *
 * All calls go through `@/lib/api-client` (same-origin, session cookie,
 * `{ data }` / `{ error }` unwrap). Fetchers are module-level functions so
 * their identity is stable for `useApiResource`. Request/response shapes
 * live in `./model` (one seam, tolerant readers).
 *
 *   GET    /api/me                                        -> { id, role }
 *   GET    /api/integrations/connectors                   -> connector[]            (admin)
 *   POST   /api/integrations/connectors                   -> connector + relay_secret (once)
 *   PATCH  /api/integrations/connectors/{id}              -> update config / pause / resume
 *   DELETE /api/integrations/connectors/{id}              -> revoke
 *   POST   /api/integrations/connectors/{id}/test         -> { ok, bot_name?, error? }
 *   POST   /api/integrations/connectors/{id}/digest       -> { delivery_id, status } (send the digest now)
 *   GET    /api/integrations/identities                   -> identity[] (mine; admin: all)
 *   POST   /api/integrations/identities/link-code         -> { code, expires_at }
 *   DELETE /api/integrations/identities/{id}              -> unlink
 *   GET    /api/calendar-feeds                            -> feed[] (mine)
 *   POST   /api/calendar-feeds                            -> { url } (once)
 *   DELETE /api/calendar-feeds/{id}                       -> revoke
 *   GET    /api/projects?limit=100                        -> project[] (feed scope picker)
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import {
  buildCreateConnectorBody,
  buildFeedBody,
  buildSettingsPatchBody,
  buildStatusPatchBody,
  normalizeCreatedConnector,
  normalizeDigestStatus,
  normalizeFeedCreated,
  normalizeFeeds,
  normalizeIdentities,
  normalizeLinkCode,
  normalizeProjects,
  normalizeTestResult,
  pickConnector,
  type ConnectFormValues,
  type ConnectorView,
  type DigestStatus,
  type FeatureValues,
  type FeedView,
  type IdentityView,
  type ProjectOption,
} from "./model";

export interface Me {
  id: string | null;
  role: string | null;
}

export async function fetchMe(): Promise<Me> {
  const data = await apiGet<{ id?: string; role?: string | null } | null>("/api/me");
  return { id: data?.id ?? null, role: data?.role ?? null };
}

// ── Lark connector ──────────────────────────────────────────────────────────

export async function fetchConnector(): Promise<ConnectorView | null> {
  return pickConnector(await apiGet<unknown>("/api/integrations/connectors"));
}

export async function createConnector(values: ConnectFormValues) {
  const raw = await apiPost<unknown>("/api/integrations/connectors", buildCreateConnectorBody(values));
  return normalizeCreatedConnector(raw);
}

export async function updateConnectorSettings(id: string, values: FeatureValues): Promise<void> {
  await apiPatch(`/api/integrations/connectors/${encodeURIComponent(id)}`, buildSettingsPatchBody(values));
}

export async function setConnectorStatus(id: string, status: "active" | "paused"): Promise<void> {
  await apiPatch(`/api/integrations/connectors/${encodeURIComponent(id)}`, buildStatusPatchBody(status));
}

export async function revokeConnector(id: string): Promise<void> {
  await apiDelete(`/api/integrations/connectors/${encodeURIComponent(id)}`);
}

export async function testConnector(id: string) {
  return normalizeTestResult(await apiPost<unknown>(`/api/integrations/connectors/${encodeURIComponent(id)}/test`));
}

export async function sendDigestNow(id: string): Promise<DigestStatus> {
  return normalizeDigestStatus(await apiPost<unknown>(`/api/integrations/connectors/${encodeURIComponent(id)}/digest`));
}

// ── Identity linking ────────────────────────────────────────────────────────

export async function fetchIdentities(): Promise<IdentityView[]> {
  return normalizeIdentities(await apiGet<unknown>("/api/integrations/identities"));
}

export async function mintLinkCode(nowMs: number) {
  const code = normalizeLinkCode(await apiPost<unknown>("/api/integrations/identities/link-code"), nowMs);
  if (!code) throw new Error("The server did not return a link code. Try again.");
  return code;
}

export async function unlinkIdentity(id: string): Promise<void> {
  await apiDelete(`/api/integrations/identities/${encodeURIComponent(id)}`);
}

// ── Calendar feeds ──────────────────────────────────────────────────────────

export async function fetchFeeds(): Promise<FeedView[]> {
  return normalizeFeeds(await apiGet<unknown>("/api/calendar-feeds"));
}

export async function createFeed(values: { name: string; projectId: string }): Promise<{ url: string }> {
  const created = normalizeFeedCreated(await apiPost<unknown>("/api/calendar-feeds", buildFeedBody(values)));
  if (!created) throw new Error("The server did not return a subscription URL. Try again.");
  return created;
}

export async function revokeFeed(id: string): Promise<void> {
  await apiDelete(`/api/calendar-feeds/${encodeURIComponent(id)}`);
}

export async function fetchProjects(): Promise<ProjectOption[]> {
  return normalizeProjects(await apiGet<unknown>("/api/projects?limit=100"));
}
