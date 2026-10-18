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
 *   PATCH  /api/integrations/connectors/{id}              -> update config / pause / resume / clear_tenant_pin
 *   DELETE /api/integrations/connectors/{id}              -> revoke
 *   POST   /api/integrations/connectors/{id}/test         -> { ok, bot_name?, error? }
 *   POST   /api/integrations/connectors/{id}/digest       -> { delivery_id, status } (send the digest now)
 *   GET    /api/integrations/identities                   -> identity[] (mine; admin: all)
 *   POST   /api/integrations/identities/link-code         -> { code, expires_at }
 *   DELETE /api/integrations/identities/{id}              -> unlink
 *   GET    /api/calendar-feeds                            -> feed[] (mine; paged, limit<=100)
 *   GET    /api/calendar-feeds?scope=workspace            -> feed[] + owner_name (admin: every member's)
 *   POST   /api/calendar-feeds                            -> { url } (once)
 *   DELETE /api/calendar-feeds/{id}                       -> revoke
 *   GET    /api/projects?limit=100                        -> project[] (feed scope picker)
 */
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import { policyOf, type ApprovalPolicy } from "@/lib/governance/tiers";
import {
  buildCreateConnectorBody,
  buildFeedBody,
  buildSettingsPatchBody,
  buildClearTenantPinBody,
  buildStatusPatchBody,
  normalizeCreatedConnector,
  normalizeDigestStatus,
  normalizeFeed,
  normalizeFeedCreated,
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

export async function clearTenantPin(id: string): Promise<void> {
  await apiPatch(`/api/integrations/connectors/${encodeURIComponent(id)}`, buildClearTenantPinBody());
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

/** A feed row plus, in the admin's workspace-wide view, who owns it. */
export interface OwnedFeedView extends FeedView {
  ownerId: string | null;
  ownerName: string | null;
}

const FEED_PAGE_LIMIT = 100;
/** Safety stop for the page loop (100 x 100 = 10,000 feeds), so a misbehaving server cannot spin it forever. */
const FEED_MAX_PAGES = 100;

function toOwnedFeed(raw: unknown): OwnedFeedView | null {
  const feed = normalizeFeed(raw);
  if (!feed || feed.revoked) return null;
  const r = raw as { created_by?: unknown; owner_name?: unknown };
  return {
    ...feed,
    ownerId: typeof r.created_by === "string" ? r.created_by : null,
    ownerName: typeof r.owner_name === "string" && r.owner_name.trim() ? r.owner_name : null,
  };
}

/**
 * Every page of `/api/calendar-feeds`, not just the first 20 the server returns
 * by default: a shorter-than-limit page is the last one.
 */
async function fetchAllFeeds(query: string): Promise<OwnedFeedView[]> {
  const feeds: OwnedFeedView[] = [];
  for (let page = 1; page <= FEED_MAX_PAGES; page++) {
    const rows = await apiGet<unknown>(`/api/calendar-feeds?${query}${query ? "&" : ""}page=${page}&limit=${FEED_PAGE_LIMIT}`);
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const feed = toOwnedFeed(row);
      if (feed) feeds.push(feed);
    }
    if (list.length < FEED_PAGE_LIMIT) break;
  }
  return feeds;
}

/** My own live feeds. */
export function fetchFeeds(): Promise<OwnedFeedView[]> {
  return fetchAllFeeds("");
}

/** Admin only: every member's live feeds, each with its owner, so a departed employee's can be revoked. */
export function fetchWorkspaceFeeds(): Promise<OwnedFeedView[]> {
  return fetchAllFeeds("scope=workspace");
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

// ── Failed deliveries (admin) ───────────────────────────────────────────────
//   GET  /api/integrations/connectors/{id}/deliveries?status=dead        -> failed message[]
//   POST /api/integrations/connectors/{id}/deliveries/{deliveryId}/retry -> { delivery_id, status }

export interface FailedDelivery {
  id: string;
  kind: string;
  approvalKind: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
}

export async function fetchFailedDeliveries(connectorId: string): Promise<FailedDelivery[]> {
  const raw = await apiGet<unknown>(`/api/integrations/connectors/${encodeURIComponent(connectorId)}/deliveries?status=dead`);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): FailedDelivery[] => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string") return [];
    return [
      {
        id: o.id,
        kind: typeof o.kind === "string" ? o.kind : "message",
        approvalKind: typeof o.approval_kind === "string" ? o.approval_kind : null,
        attempts: typeof o.attempts === "number" ? o.attempts : 0,
        lastError: typeof o.last_error === "string" ? o.last_error : null,
        createdAt: typeof o.created_at === "string" ? o.created_at : null,
      },
    ];
  });
}

export async function retryFailedDelivery(connectorId: string, deliveryId: string): Promise<string> {
  const raw = await apiPost<{ status?: string } | null>(
    `/api/integrations/connectors/${encodeURIComponent(connectorId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
  );
  return raw?.status ?? "queued";
}

// ── Workspace time zone ─────────────────────────────────────────────────────
//   GET   /api/workspace-settings  -> { time_zone, default_time_zone }
//   PATCH /api/workspace-settings  -> { time_zone }   (admin)

export async function fetchTimeZone(): Promise<{ timeZone: string; defaultTimeZone: string }> {
  const raw = await apiGet<{ time_zone?: string; default_time_zone?: string } | null>("/api/workspace-settings");
  const def = raw?.default_time_zone ?? "Asia/Kuala_Lumpur";
  return { timeZone: raw?.time_zone ?? def, defaultTimeZone: def };
}

export async function saveTimeZone(timeZone: string): Promise<void> {
  await apiPatch("/api/workspace-settings", { time_zone: timeZone });
}

// ── nudges + weekly report (R-141 / R-142) ───────────────────────────────────
//   GET   /api/workspace-settings  -> { stale_days, nudges_enabled, weekly_report_enabled, weekly_report_day, ... }
//   PATCH /api/workspace-settings  -> any subset of the same fields (admin)
//   POST  /api/reports/weekly      -> { week_start, recipients, report_url } (admin or manager)

export type NudgeSettingsView = {
  staleDays: number;
  nudgesEnabled: boolean;
  weeklyReportEnabled: boolean;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weeklyReportDay: number;
};

export async function fetchNudgeSettings(): Promise<NudgeSettingsView> {
  const raw = await apiGet<{
    stale_days?: number;
    nudges_enabled?: boolean;
    weekly_report_enabled?: boolean;
    weekly_report_day?: number;
  } | null>("/api/workspace-settings");
  return {
    staleDays: typeof raw?.stale_days === "number" ? raw.stale_days : 14,
    nudgesEnabled: raw?.nudges_enabled !== false,
    weeklyReportEnabled: raw?.weekly_report_enabled !== false,
    weeklyReportDay: typeof raw?.weekly_report_day === "number" ? raw.weekly_report_day : 1,
  };
}

export async function saveNudgeSettings(v: NudgeSettingsView): Promise<void> {
  await apiPatch("/api/workspace-settings", {
    stale_days: v.staleDays,
    nudges_enabled: v.nudgesEnabled,
    weekly_report_enabled: v.weeklyReportEnabled,
    weekly_report_day: v.weeklyReportDay,
  });
}

/** The workspace approval policy with every default filled in (GET /api/workspace-settings -> approval_policy). */
export async function fetchApprovalPolicy(): Promise<ApprovalPolicy> {
  const raw = await apiGet<{ approval_policy?: unknown } | null>("/api/workspace-settings");
  return policyOf(raw?.approval_policy);
}

export async function saveApprovalPolicy(p: ApprovalPolicy): Promise<void> {
  await apiPatch("/api/workspace-settings", { approval_policy: p });
}

export async function sendWeeklyReportNow(): Promise<{ weekStart: string; recipients: number; reportUrl: string }> {
  const raw = await apiPost<{ week_start: string; recipients: number; report_url: string }>("/api/reports/weekly", {});
  return { weekStart: raw.week_start, recipients: raw.recipients, reportUrl: raw.report_url };
}
