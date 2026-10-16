/**
 * Integration Hub — shared types (2026-10-16, Lark v1).
 *
 * The hub is event FAN-OUT, not an automations engine (sprint-log
 * 2026-10-16_lark-integration/PLAN.md, D8): it sends fixed message types to
 * fixed recipients, and the only inbound mutation it ever performs is a
 * human, identity-verified, single-use approve/reject on a governed request
 * that already exists — routed through the same `decideApproval` the REST
 * routes use, so four-eyes, scopes, locks and the one-audit-row rule apply
 * unchanged.
 *
 * Adapters (one per platform, `src/lib/integrations/<kind>/`) are pure
 * translation: render a message, send/patch it, verify + parse a callback.
 * Persistence, retries, identity, idempotency and governance live in the hub
 * core, never in an adapter.
 */

/** A governed request that a human can approve or reject from a chat card. */
export type ApprovalKind = "task_deletion" | "project_deletion" | "change_request" | "timesheet";

export const APPROVAL_KINDS: readonly ApprovalKind[] = [
  "task_deletion",
  "project_deletion",
  "change_request",
  "timesheet",
];

export type ApprovalRef = { kind: ApprovalKind; id: string };

/** Emitted when a governed request is raised (after its audit row is written). */
export type ApprovalEvent = {
  workspaceId: string;
  kind: ApprovalKind;
  /** deletion_requests.id / change_requests.id / timesheet_submissions.id */
  id: string;
  /** One-line human summary, e.g. `Delete task "Migrate billing DB"`. */
  title: string;
  /** Optional longer context (reason, rationale, hours). Plain text. */
  summary?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  /** Display label of whoever raised it (person, or "<token> (token)"). */
  requestedByLabel: string;
  /** The HUMAN behind the request — excluded from the approver fan-out. */
  requesterPrincipalId: string | null;
};

/** Emitted after a request is approved / rejected / withdrawn / reopened, from ANY channel. */
export type ApprovalDecidedEvent = ApprovalEvent & {
  /** The request's new status, e.g. "committed", "rejected", "approved", "withdrawn". */
  status: string;
  decidedByLabel: string;
  /** Audit channel the decision came through ("ui", "cli", "mcp", "lark", ...). */
  channel: string;
};

export type LarkRegion = "lark" | "feishu";

/** Non-secret connector configuration (stored as plain jsonb). */
export type LarkConfig = {
  region: LarkRegion;
  appId: string;
  /** "webhook" = hosted callback routes; "long_connection" = self-host relay worker. */
  mode: "webhook" | "long_connection";
  approvals: { enabled: boolean };
  digest: {
    enabled: boolean;
    /** Lark group chat id (oc_…) the weekly digest is posted to. */
    chatId: string | null;
    /** 0 = Sunday … 6 = Saturday, evaluated in UTC by the daily cron. */
    weekday: number;
  };
};

/** Secret connector material — AES-256-GCM encrypted at rest, never returned by any API. */
export type LarkSecrets = {
  appSecret: string;
  verificationToken: string;
  /** Optional: enables encrypted + signed event delivery. */
  encryptKey?: string | null;
};

export type ConnectorStatus = "active" | "paused" | "revoked";

/** A row of integration_connectors as the server sees it (secrets still encrypted). */
export type ConnectorRow = {
  id: string;
  workspace_id: string;
  kind: "lark";
  name: string;
  status: ConnectorStatus;
  config: LarkConfig;
  secret_enc: string;
  relay_secret_hash: string | null;
  /** Pinned platform tenant (set by the first identity link); null = not pinned yet. */
  tenant_key?: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type DeliveryKind = "approval_card" | "decision_update" | "digest" | "bot_reply";

export type DeliveryStatus = "pending" | "sent" | "retry" | "dead" | "superseded";

/** A row of integration_deliveries (the outbound queue). */
export type DeliveryRow = {
  id: string;
  workspace_id: string;
  connector_id: string;
  kind: DeliveryKind;
  approval_kind: ApprovalKind | null;
  approval_id: string | null;
  recipient_profile_id: string | null;
  /** open_id (DM) or chat_id (group). */
  external_target: string | null;
  parent_delivery_id: string | null;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  locked_until: string | null;
  external_message_id: string | null;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
};

/** A message the adapter will send (opaque to the hub core). */
export type OutboundMessage = {
  /** "open_id" for a person's DM, "chat_id" for a group. */
  receiveIdType: "open_id" | "chat_id";
  receiveId: string;
  /** Adapter-specific body, e.g. a Lark card JSON 2.0 object. */
  body: Record<string, unknown>;
};

export type DeliverResult =
  | { ok: true; externalMessageId: string | null }
  | { ok: false; retryable: boolean; error: string };

/** Data a weekly digest renders (gathered by the hub core, workspace-filtered). */
export type DigestData = {
  workspaceName: string;
  generatedAt: string;
  appUrl: string;
  projects: { id: string; name: string; health: string | null; status: string | null }[];
  milestonesDueSoon: { id: string; name: string; projectName: string | null; dueDate: string }[];
  openHighRisks: number;
  pendingApprovals: number;
};

/** Outcome of an inbound approve/reject — the adapter turns it into a toast + card. */
export type InboundOutcome =
  | { status: "decided"; action: "approve" | "reject"; ref: ApprovalRef; title: string; newStatus: string }
  | { status: "unlinked" }
  | { status: "expired" }
  | { status: "not_recipient" }
  | { status: "self_approval" }
  | { status: "already_decided"; newStatus?: string }
  | { status: "forbidden"; message: string }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

/**
 * The platform adapter contract. Pure translation + transport; no DB access,
 * no governance decisions.
 */
export type ConnectorAdapter = {
  kind: "lark";
  renderApprovalCard(ev: ApprovalEvent, ctx: { actionToken: string; appUrl: string }): Record<string, unknown>;
  renderDecisionUpdate(ev: ApprovalDecidedEvent, ctx: { appUrl: string }): Record<string, unknown>;
  renderDigest(data: DigestData): Record<string, unknown>;
  /** Send a new message. */
  send(connector: ConnectorRow, secrets: LarkSecrets, msg: OutboundMessage): Promise<DeliverResult>;
  /** Replace the content of a previously sent card. */
  update(
    connector: ConnectorRow,
    secrets: LarkSecrets,
    externalMessageId: string,
    body: Record<string, unknown>,
  ): Promise<DeliverResult>;
  /** Cheap credential check (e.g. fetch bot info). */
  testConnection(connector: ConnectorRow, secrets: LarkSecrets): Promise<{ ok: true; botName: string | null } | { ok: false; error: string }>;
};
