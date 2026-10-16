/**
 * Integrations console — the single seam between the UI and the integration
 * APIs (PLAN 2026-10-16: W3a hub routes, W4 calendar feeds).
 *
 * Every wire shape the page reads or sends is normalised/built HERE and
 * nowhere else, so a route-contract change is a one-file edit. Readers are
 * deliberately tolerant — snake_case or camelCase, config nested or flat,
 * extra keys ignored, missing optionals defaulted — because the APIs are
 * built in parallel with this page and the response must never be able to
 * crash a render. Nothing here touches React, `window` or the network, so it
 * is fully unit-tested.
 *
 * Secrets: the only secrets this page ever holds are the ones the admin just
 * typed (sent once, then dropped) and the one-time values the API returns on
 * create (relay secret, calendar URL). None is persisted or logged.
 */
import type { ConnectorStatus, LarkConfig, LarkRegion } from "@/lib/integrations/types";
import { formatRelativeTime, parseExpiry, validateChatId, type CallbackUrls } from "./format";

type Rec = Record<string, unknown>;

export type LarkMode = LarkConfig["mode"];

export const REGION_LABEL: Record<LarkRegion, string> = {
  lark: "Lark (international)",
  feishu: "Feishu (China)",
};

export const MODE_LABEL: Record<LarkMode, string> = {
  webhook: "Webhook",
  long_connection: "Long connection",
};

// ── tolerant readers ────────────────────────────────────────────────────────

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstDefined(...vals: unknown[]): unknown {
  return vals.find((v) => v !== undefined && v !== null);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

// ── errors ──────────────────────────────────────────────────────────────────

export type ErrorKind = "unavailable" | "forbidden" | "error";

/**
 * How a failed GET should render. 404 = the route isn't deployed (calm
 * "not available" copy, never an alarm); 403 = the caller's role can't see it.
 */
export function classifyError(e: unknown): { kind: ErrorKind; message: string } {
  const status = isRec(e) && typeof e.status === "number" ? e.status : undefined;
  const message = e instanceof Error && e.message ? e.message : "Something went wrong.";
  if (status === 404) return { kind: "unavailable", message };
  if (status === 403) return { kind: "forbidden", message };
  return { kind: "error", message };
}

/** User-facing text for a thrown API error, with any field-level detail appended. */
export function errorText(e: unknown, fallback: string): string {
  const base = e instanceof Error && e.message ? e.message : fallback;
  const fields = isRec(e) && Array.isArray(e.fields) ? e.fields : [];
  const details = fields
    .filter((f): f is { field: string; message: string } => isRec(f) && typeof f.field === "string" && typeof f.message === "string")
    .map((f) => `${f.field}: ${f.message}`);
  return details.length > 0 ? `${base} (${details.join("; ")})` : base;
}

// ── connector ───────────────────────────────────────────────────────────────

export interface DeliveryHealth {
  sent: number;
  pending: number;
  retrying: number;
  dead: number;
  lastSentAt: string | null;
  lastError: string | null;
}

export interface ConnectorView {
  id: string;
  name: string;
  status: ConnectorStatus;
  region: LarkRegion;
  mode: LarkMode;
  appId: string;
  hasEncryptKey: boolean;
  /** False when the server can no longer decrypt the stored credentials (encryption key changed). */
  secretsReadable: boolean;
  /**
   * The connection is locked to the first Lark workspace that linked an account.
   * The API reports only that it is pinned, never the key; the redacted member
   * view omits it.
   */
  tenantPinned: boolean;
  approvalsEnabled: boolean;
  digest: { enabled: boolean; chatId: string | null; weekday: number };
  createdAt: string | null;
  /** Only present when the API chooses to return delivery health. */
  health: DeliveryHealth | null;
  /** Server-built webhook URLs (configured app URL). Present on create; absent on the redacted member view. */
  callbackUrls: CallbackUrls | null;
}

/** `callback_urls` from the API, or null unless both the event and card URLs are present. */
export function readCallbackUrls(raw: unknown): CallbackUrls | null {
  if (!isRec(raw)) return null;
  const events = asString(raw.events);
  const card = asString(raw.card);
  return events && card ? { events, card, relay: asString(raw.relay) } : null;
}

export function readDeliveryHealth(raw: unknown): DeliveryHealth | null {
  if (!isRec(raw)) return null;
  return {
    sent: asCount(firstDefined(raw.sent, raw.sent_count)),
    pending: asCount(raw.pending),
    retrying: asCount(firstDefined(raw.retrying, raw.retry)),
    dead: asCount(firstDefined(raw.dead, raw.failed)),
    lastSentAt: asString(firstDefined(raw.last_sent_at, raw.lastSentAt)),
    lastError: asString(firstDefined(raw.last_error, raw.lastError)),
  };
}

export function normalizeConnector(raw: unknown): ConnectorView | null {
  if (!isRec(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;

  const cfg = isRec(raw.config) ? raw.config : {};
  const digestRaw = firstDefined(cfg.digest, raw.digest);
  const digest = isRec(digestRaw) ? digestRaw : {};
  const approvalsRaw = firstDefined(cfg.approvals, raw.approvals);

  const modeRaw = firstDefined(cfg.mode, raw.mode);
  const statusRaw = asString(raw.status);
  const weekdayRaw = firstDefined(digest.weekday, raw.digest_weekday);

  return {
    id,
    name: asString(raw.name) ?? "Lark",
    status: statusRaw === "paused" || statusRaw === "revoked" ? statusRaw : "active",
    region: firstDefined(cfg.region, raw.region) === "feishu" ? "feishu" : "lark",
    mode: typeof modeRaw === "string" && modeRaw.toLowerCase().includes("long") ? "long_connection" : "webhook",
    appId: asString(firstDefined(cfg.appId, cfg.app_id, raw.app_id, raw.appId)) ?? "",
    hasEncryptKey: asBool(firstDefined(raw.has_encrypt_key, raw.hasEncryptKey, cfg.has_encrypt_key), false),
    secretsReadable: asBool(firstDefined(raw.secrets_readable, raw.secretsReadable), true),
    tenantPinned: asBool(firstDefined(raw.tenant_pinned, raw.tenantPinned), false),
    approvalsEnabled: isRec(approvalsRaw)
      ? asBool(approvalsRaw.enabled, false)
      : asBool(firstDefined(raw.approvals_enabled, raw.approvalsEnabled), false),
    digest: {
      enabled: asBool(firstDefined(digest.enabled, raw.digest_enabled), false),
      chatId: asString(firstDefined(digest.chatId, digest.chat_id, raw.digest_chat_id)),
      weekday:
        typeof weekdayRaw === "number" && Number.isInteger(weekdayRaw) && weekdayRaw >= 0 && weekdayRaw <= 6
          ? weekdayRaw
          : 1,
    },
    createdAt: asString(firstDefined(raw.created_at, raw.createdAt)),
    health: readDeliveryHealth(firstDefined(raw.delivery_health, raw.deliveryHealth, raw.health)),
    callbackUrls: readCallbackUrls(firstDefined(raw.callback_urls, raw.callbackUrls)),
  };
}

/**
 * The read-only status line a non-admin member sees. The API gives members a
 * redacted connector (id, name, kind, status, region, mode, approvals.enabled,
 * digest.enabled) — everything below is derivable from exactly those fields.
 */
export function readOnlySummary(c: ConnectorView): string {
  const state = c.status === "paused" ? "Lark paused" : "Lark connected";
  return `${state} · approvals ${c.approvalsEnabled ? "on" : "off"} · digest ${c.digest.enabled ? "on" : "off"}`;
}

/** The workspace's live connector: the first non-revoked row of a GET list (revoked rows are history). */
export function pickConnector(list: unknown): ConnectorView | null {
  if (!Array.isArray(list)) return null;
  const views = list.map(normalizeConnector).filter((c): c is ConnectorView => c !== null);
  return views.find((c) => c.status !== "revoked") ?? null;
}

/** Result of `POST /api/integrations/connectors`: the connector plus the one-time relay secret. */
export function normalizeCreatedConnector(raw: unknown): { connector: ConnectorView | null; relaySecret: string | null } {
  if (!isRec(raw)) return { connector: null, relaySecret: null };
  const nested = isRec(raw.connector) ? raw.connector : raw;
  const connector = normalizeConnector(nested);
  // `callback_urls` sits beside the connector fields; keep it even if the connector were nested.
  const callbackUrls = readCallbackUrls(firstDefined(raw.callback_urls, raw.callbackUrls));
  return {
    connector: connector && !connector.callbackUrls && callbackUrls ? { ...connector, callbackUrls } : connector,
    relaySecret: asString(firstDefined(raw.relay_secret, raw.relaySecret, nested.relay_secret)),
  };
}

export type HealthTone = "success" | "warning" | "danger" | "neutral";

/** One-line summary of delivery health + the badge tone that goes with it. */
export function summariseDeliveryHealth(h: DeliveryHealth, nowMs: number): { tone: HealthTone; text: string } {
  const parts: string[] = [];
  if (h.sent > 0) parts.push(`${h.sent} sent`);
  if (h.pending > 0) parts.push(`${h.pending} queued`);
  if (h.retrying > 0) parts.push(`${h.retrying} retrying`);
  if (h.dead > 0) parts.push(`${h.dead} failed`);
  if (h.lastSentAt) parts.push(`last sent ${formatRelativeTime(h.lastSentAt, nowMs)}`);
  const tone: HealthTone = h.dead > 0 ? "danger" : h.retrying > 0 ? "warning" : h.sent > 0 ? "success" : "neutral";
  return { tone, text: parts.length > 0 ? parts.join(" · ") : "No deliveries yet" };
}

// ── connector forms ─────────────────────────────────────────────────────────

/** The toggles + digest target, shared by the connect form and the edit-settings panel. */
export interface FeatureValues {
  approvalsEnabled: boolean;
  digestEnabled: boolean;
  digestChatId: string;
  digestWeekday: number;
}

export interface ConnectFormValues extends FeatureValues {
  name: string;
  region: LarkRegion;
  mode: LarkMode;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
}

export const DEFAULT_FEATURES: FeatureValues = {
  approvalsEnabled: true,
  digestEnabled: false,
  digestChatId: "",
  digestWeekday: 1,
};

export const DEFAULT_CONNECT_VALUES: ConnectFormValues = {
  name: "Lark",
  region: "lark",
  mode: "webhook",
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  ...DEFAULT_FEATURES,
};

/** Seeds the edit-settings panel from the connector as it currently stands. */
export function featuresFromConnector(c: ConnectorView): FeatureValues {
  return {
    approvalsEnabled: c.approvalsEnabled,
    digestEnabled: c.digest.enabled,
    digestChatId: c.digest.chatId ?? "",
    digestWeekday: c.digest.weekday,
  };
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;

export function validateFeatures(v: FeatureValues): FormErrors<FeatureValues> {
  const errors: FormErrors<FeatureValues> = {};
  if (v.digestEnabled) {
    const chatError = validateChatId(v.digestChatId);
    if (chatError) errors.digestChatId = chatError;
  }
  return errors;
}

export function validateConnectForm(v: ConnectFormValues): FormErrors<ConnectFormValues> {
  const errors: FormErrors<ConnectFormValues> = { ...validateFeatures(v) };
  if (!v.name.trim()) errors.name = "Give the connection a name.";
  else if (v.name.trim().length > 80) errors.name = "Keep the name under 80 characters.";
  if (!v.appId.trim()) errors.appId = "Paste the App ID from your Lark app.";
  else if (!/^[A-Za-z0-9_-]+$/.test(v.appId.trim())) errors.appId = "App IDs use only letters, digits, - and _.";
  if (!v.appSecret.trim()) errors.appSecret = "Paste the App Secret from your Lark app.";
  if (!v.verificationToken.trim()) errors.verificationToken = "Paste the Verification Token from Events & Callbacks.";
  return errors;
}

/** Approvals + digest in the exact shape the API echoes back (`approvals`, `digest.chat_id`). */
function featureBody(v: FeatureValues) {
  const chatId = v.digestChatId.trim();
  return {
    approvals: { enabled: v.approvalsEnabled },
    digest: {
      enabled: v.digestEnabled,
      // Switching the digest off keeps a well-formed chat id (so switching it
      // back on doesn't mean retyping it); anything malformed is dropped.
      chat_id: v.digestEnabled || validateChatId(chatId) === null ? chatId || null : null,
      weekday: v.digestWeekday,
    },
  };
}

/**
 * `POST /api/integrations/connectors` body. Flat snake_case, symmetric with the
 * connector the API returns (`toPublicConnector`): non-secret fields keep their
 * response names, secret material goes in as `app_secret`, `verification_token`
 * and (optionally) `encrypt_key` and is never echoed back.
 */
export function buildCreateConnectorBody(v: ConnectFormValues): Rec {
  const encryptKey = v.encryptKey.trim();
  return {
    kind: "lark",
    name: v.name.trim(),
    region: v.region,
    mode: v.mode,
    app_id: v.appId.trim(),
    ...featureBody(v),
    app_secret: v.appSecret.trim(),
    verification_token: v.verificationToken.trim(),
    ...(encryptKey ? { encrypt_key: encryptKey } : {}),
  };
}

/** `PATCH /api/integrations/connectors/[id]` body for the edit-settings panel (non-secret fields only). */
export function buildSettingsPatchBody(v: FeatureValues): Rec {
  return featureBody(v);
}

/**
 * `PATCH /api/integrations/connectors/[id]` body that lifts the Lark-workspace
 * lock (admin only); the next account link pins the connection again.
 */
export function buildClearTenantPinBody(): Rec {
  return { clear_tenant_pin: true };
}

/** `PATCH /api/integrations/connectors/[id]` body for pause / resume. */
export function buildStatusPatchBody(status: Exclude<ConnectorStatus, "revoked">): Rec {
  return { status };
}

/** Result of `POST …/connectors/[id]/test`: ok unless the API says otherwise. */
export function normalizeTestResult(raw: unknown): { ok: boolean; botName: string | null; error: string | null } {
  if (!isRec(raw)) return { ok: true, botName: null, error: null };
  const ok = raw.ok !== false && !asString(raw.error);
  return {
    ok,
    botName: asString(firstDefined(raw.bot_name, raw.botName)),
    error: asString(raw.error),
  };
}

export type DigestStatus = "sent" | "queued" | "retry" | "dead";

/** `POST …/digest` answers `{ delivery_id, status }`; an unknown status is treated as queued. */
export function normalizeDigestStatus(raw: unknown): DigestStatus {
  const status = isRec(raw) ? raw.status : undefined;
  return status === "sent" || status === "retry" || status === "dead" ? status : "queued";
}

/** Honest feedback for "Send digest now": what actually happened, not just that the request was accepted. */
export function digestOutcome(status: DigestStatus): { tone: "success" | "info" | "error"; message: string } {
  switch (status) {
    case "sent":
      return { tone: "success", message: "Digest sent to the group chat." };
    case "retry":
      return { tone: "info", message: "Lark didn't accept the digest yet. NoPM will retry automatically." };
    case "dead":
      return {
        tone: "error",
        message: "Lark rejected the digest. Check the group chat ID and that the bot is in the group.",
      };
    default:
      return { tone: "info", message: "Digest queued. It will be delivered shortly." };
  }
}

// ── identity linking ────────────────────────────────────────────────────────

export interface IdentityView {
  id: string;
  profileId: string | null;
  displayName: string | null;
  linkedAt: string | null;
  revoked: boolean;
}

export function normalizeIdentity(raw: unknown): IdentityView | null {
  if (!isRec(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    profileId: asString(firstDefined(raw.profile_id, raw.profileId)),
    displayName: asString(firstDefined(raw.display_name, raw.displayName)),
    linkedAt: asString(firstDefined(raw.linked_at, raw.linkedAt)),
    revoked: asString(firstDefined(raw.revoked_at, raw.revokedAt)) !== null,
  };
}

export function normalizeIdentities(list: unknown): IdentityView[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeIdentity).filter((i): i is IdentityView => i !== null);
}

/**
 * The signed-in member's own active link. `GET …/identities` returns only
 * "mine" for members but EVERYONE's for admins, so rows are matched on
 * `profile_id` whenever the API provides it.
 */
export function findMyIdentity(list: IdentityView[], myProfileId: string | null): IdentityView | null {
  return list.find((i) => !i.revoked && (i.profileId === null || i.profileId === myProfileId)) ?? null;
}

/** Result of `POST …/identities/link-code`: the one-time code and its absolute expiry (epoch ms). */
export function normalizeLinkCode(raw: unknown, nowMs: number): { code: string; expiresAt: number } | null {
  if (!isRec(raw)) return null;
  const code = asString(raw.code);
  if (!code) return null;
  const expiresIso = firstDefined(raw.expires_at, raw.expiresAt);
  const inSeconds = firstDefined(raw.expires_in, raw.expiresIn);
  const expiresAt =
    typeof inSeconds === "number" && Number.isFinite(inSeconds) && expiresIso === undefined
      ? nowMs + inSeconds * 1000
      : parseExpiry(expiresIso, nowMs);
  return { code, expiresAt };
}

// ── calendar feeds ──────────────────────────────────────────────────────────

export interface FeedView {
  id: string;
  name: string;
  projectId: string | null;
  createdAt: string | null;
  lastFetchedAt: string | null;
  revoked: boolean;
}

export function normalizeFeed(raw: unknown): FeedView | null {
  if (!isRec(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    name: asString(raw.name) ?? "Calendar feed",
    projectId: asString(firstDefined(raw.project_id, raw.projectId)),
    createdAt: asString(firstDefined(raw.created_at, raw.createdAt)),
    lastFetchedAt: asString(firstDefined(raw.last_fetched_at, raw.lastFetchedAt)),
    revoked: asString(firstDefined(raw.revoked_at, raw.revokedAt)) !== null,
  };
}

/** My live feeds (revoked rows are hidden). */
export function normalizeFeeds(list: unknown): FeedView[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeFeed).filter((f): f is FeedView => f !== null && !f.revoked);
}

/** Result of `POST /api/calendar-feeds`: the secret subscription URL, returned exactly once. */
export function normalizeFeedCreated(raw: unknown): { url: string } | null {
  if (!isRec(raw)) return null;
  const url = asString(raw.url);
  return url ? { url } : null;
}

export function buildFeedBody(v: { name: string; projectId: string }): Rec {
  return { name: v.name.trim(), ...(v.projectId ? { project_id: v.projectId } : {}) };
}

export interface ProjectOption {
  id: string;
  name: string;
}

export function normalizeProjects(list: unknown): ProjectOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((p): ProjectOption | null => {
      if (!isRec(p)) return null;
      const id = asString(p.id);
      const name = asString(p.name);
      return id && name ? { id, name } : null;
    })
    .filter((p): p is ProjectOption => p !== null);
}
