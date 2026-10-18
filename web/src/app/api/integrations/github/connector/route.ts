import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { created, ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import { assertIntegrationAdmin } from "@/lib/integrations/store";
import { loadWorkEventRules } from "@/lib/integrations/github/process";
import { RULE_TARGETS, WORK_EVENT_KINDS, normalizeRules, validateRulesPatch } from "@/lib/integrations/github/rules";
import { encryptWebhookSecret, generateWebhookSecret } from "@/lib/integrations/github/secrets";
import {
  getLiveGithubConnector,
  toPublicGithubConnector,
  type GithubConnectorRow,
} from "@/lib/integrations/github/store";

export const runtime = "nodejs";

const GITHUB_CONNECTOR_NAME_MAX = 100;

/**
 * GitHub work-event connector (R-153, audit A1). One live connector per workspace; admin sessions only
 * (never a token), like the Lark connector. The webhook signing secret is generated here, encrypted at
 * rest and returned exactly once (on create and on rotate); no API ever returns it again.
 *
 *   GET    -> { connector | null, can_manage, rules, rule_targets, work_events }  (any signed-in member reads the rules)
 *   POST   -> create the connector            { name? }          -> connector + secret (once)
 *   PATCH  -> { status?: active|paused, rules?: {event: target|null}, rotate_secret?: true }
 *   DELETE -> revoke the connector (frees the slot; history stays)
 */

const origin = (request: Request) => new URL(request.url).origin;

export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") throw new ApiError(403, "GitHub work events are available to signed-in users", "forbidden");
  const db = createAdminClient();
  const row = await getLiveGithubConnector(db, actor.workspaceId);
  const rules = await loadWorkEventRules(db, actor.workspaceId);
  const isAdmin = actor.role === "admin";
  return ok({
    // Members learn that a connector exists and its state; only admins get the id and webhook URL.
    connector: row ? (isAdmin ? toPublicGithubConnector(row, origin(request)) : { name: row.name, status: row.status }) : null,
    can_manage: isAdmin,
    rules,
    rule_targets: RULE_TARGETS,
    work_events: WORK_EVENT_KINDS,
  });
});

export const POST = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const body = (await safeJson(request)) as { name?: unknown } | null;
  const rawName = body && typeof body === "object" && "name" in body ? body.name : undefined;
  if (rawName !== undefined && (typeof rawName !== "string" || rawName.trim().length < 1 || rawName.trim().length > GITHUB_CONNECTOR_NAME_MAX)) {
    return validationError("Validation failed", [{ field: "name", message: `name must be 1 to ${GITHUB_CONNECTOR_NAME_MAX} characters` }]);
  }
  const name = typeof rawName === "string" ? rawName.trim() : "GitHub";

  const db = createAdminClient();
  if (await getLiveGithubConnector(db, actor.workspaceId)) {
    throw new RuleError("This workspace already has a GitHub connector. Revoke it before connecting another.", "connector_exists");
  }

  const secret = generateWebhookSecret();
  let secretEnc: string;
  try {
    secretEnc = encryptWebhookSecret(secret);
  } catch {
    throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
  }

  // ONE database function (migration 0109): the connector row and its audit row are one transaction. The audit
  // payload is {kind, name, status}; the encrypted secret is written and never read into an audit row.
  const { data: written, error } = await db.rpc("nopm_github_connector_write", {
    p_workspace_id: actor.workspaceId, // always from the actor, never the body
    p_op: "create",
    p_name: name,
    p_secret_enc: secretEnc,
    p_created_by: actor.id,
    p_audit: buildRpcAudit(actor, "integration.connector.create", "integration_connector"),
  });
  if (error?.code === "23505") {
    throw new RuleError("This workspace already has a GitHub connector.", "connector_exists");
  }
  const row = (written as { connector?: unknown } | null)?.connector;
  if (error || !row) throw error ?? new Error("Failed to create connector");

  const view = toPublicGithubConnector(row as unknown as GithubConnectorRow, origin(request));
  return created({ ...view, webhook_secret: secret });
});

export const PATCH = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const input = (await safeJson(request)) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return validationError("Validation failed", [{ field: "body", message: "Send a JSON object" }]);
  const allowed = new Set(["status", "rules", "rotate_secret"]);
  const unknownKey = Object.keys(input).find((k) => !allowed.has(k));
  if (unknownKey) return validationError("Validation failed", [{ field: unknownKey, message: "Unknown field" }]);
  if (Object.keys(input).length === 0) return validationError("Validation failed", [{ field: "body", message: "Provide at least one field to update" }]);

  const db = createAdminClient();
  const existing = await getLiveGithubConnector(db, actor.workspaceId);

  const wantsConnector = "status" in input || "rotate_secret" in input;
  if (wantsConnector && !existing) throw new NotFoundError("No GitHub connector to update");
  if ("status" in input && input.status !== "active" && input.status !== "paused") {
    return validationError("Validation failed", [{ field: "status", message: "status must be 'active' or 'paused'" }]);
  }
  if ("rotate_secret" in input && input.rotate_secret !== true) {
    return validationError("Validation failed", [{ field: "rotate_secret", message: "rotate_secret must be true" }]);
  }
  let rulesPatch: ReturnType<typeof validateRulesPatch> | null = null;
  if ("rules" in input) {
    rulesPatch = validateRulesPatch(input.rules);
    if (!rulesPatch.ok) return validationError("Validation failed", [{ field: "rules", message: rulesPatch.message }]);
  }

  let newSecret: string | null = null;
  let view = existing ? toPublicGithubConnector(existing, origin(request)) : null;

  let statusArg: string | null = null;
  let secretEncArg: string | null = null;
  if (existing && wantsConnector) {
    if ("status" in input) statusArg = input.status as string;
    if (input.rotate_secret === true) {
      newSecret = generateWebhookSecret();
      try {
        secretEncArg = encryptWebhookSecret(newSecret);
      } catch {
        throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
      }
    }
  }

  let rules = await loadWorkEventRules(db, actor.workspaceId);
  const nextRules = rulesPatch && rulesPatch.ok ? normalizeRules({ ...rules, ...rulesPatch.rules }) : null;

  // ONE database function (migration 0109): the connector change (status, rotated secret) AND workspaces.work_event_rules
  // are written in one transaction, each with its own audit row (integration.connector.update and
  // work_event_rules.update), or none of it is. The webhook secret never enters an audit payload.
  const { data: written, error: writeError } = await db.rpc("nopm_github_connector_write", {
    p_workspace_id: actor.workspaceId,
    p_op: "update",
    p_connector_id: existing && wantsConnector ? existing.id : null,
    p_status: statusArg,
    p_secret_enc: secretEncArg,
    p_secret_rotated: newSecret !== null,
    p_rules_after: nextRules,
    p_audit: buildRpcAudit(actor, "integration.connector.update", "integration_connector"),
  });
  if (writeError) {
    if (/CONNECTOR_NOT_FOUND/.test(writeError.message)) throw new NotFoundError("No GitHub connector to update");
    throw writeError;
  }
  const result = (written ?? {}) as { connector?: unknown };
  if (existing && wantsConnector) {
    if (!result.connector) throw new NotFoundError("No GitHub connector to update");
    view = toPublicGithubConnector(result.connector as unknown as GithubConnectorRow, origin(request));
  }
  if (nextRules) rules = nextRules;

  return ok({ connector: view, rules, ...(newSecret ? { webhook_secret: newSecret } : {}) });
});

export const DELETE = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const db = createAdminClient();
  const existing = await getLiveGithubConnector(db, actor.workspaceId);
  if (!existing) throw new NotFoundError("No GitHub connector to revoke");
  // ONE database function (migration 0109): the revoke and its audit row are one transaction.
  const { data: written, error } = await db.rpc("nopm_github_connector_write", {
    p_workspace_id: actor.workspaceId,
    p_op: "revoke",
    p_connector_id: existing.id,
    p_audit: buildRpcAudit(actor, "integration.connector.revoke", "integration_connector"),
  });
  if (error) {
    if (/CONNECTOR_REVOKED/.test(error.message)) throw new RuleError("This connector is already revoked", "connector_revoked");
    if (/CONNECTOR_NOT_FOUND/.test(error.message)) throw new NotFoundError("No GitHub connector to revoke");
    throw error;
  }
  const row = (written as { connector?: unknown } | null)?.connector;
  if (!row) throw new RuleError("This connector is already revoked", "connector_revoked");
  const view = toPublicGithubConnector(row as unknown as GithubConnectorRow, origin(request));
  return ok(view);
});
