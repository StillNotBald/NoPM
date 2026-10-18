import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { created, ok, safeJson, validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { assertIntegrationAdmin } from "@/lib/integrations/store";
import { loadWorkEventRules } from "@/lib/integrations/github/process";
import { RULE_TARGETS, WORK_EVENT_KINDS, normalizeRules, validateRulesPatch } from "@/lib/integrations/github/rules";
import { encryptWebhookSecret, generateWebhookSecret } from "@/lib/integrations/github/secrets";
import {
  GITHUB_CONNECTOR_COLUMNS,
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

  const { data: row, error } = await db
    .from("integration_connectors")
    .insert({
      workspace_id: actor.workspaceId, // always from the actor, never the body
      kind: "github",
      name,
      status: "active",
      config: {},
      secret_enc: secretEnc,
      created_by: actor.id,
    })
    .select(GITHUB_CONNECTOR_COLUMNS)
    .single();
  if (error?.code === "23505") {
    throw new RuleError("This workspace already has a GitHub connector.", "connector_exists");
  }
  if (error || !row) throw error ?? new Error("Failed to create connector");

  const view = toPublicGithubConnector(row as unknown as GithubConnectorRow, origin(request));
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.connector.create",
    targetType: "integration_connector",
    targetId: view.id,
    before: null,
    after: { kind: "github", name: view.name, status: view.status },
  });
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

  if (existing && wantsConnector) {
    const update: Record<string, unknown> = {};
    if ("status" in input) update.status = input.status;
    if (input.rotate_secret === true) {
      newSecret = generateWebhookSecret();
      try {
        update.secret_enc = encryptWebhookSecret(newSecret);
      } catch {
        throw new ApiError(503, "Server encryption key (NOPM_ENCRYPTION_KEY) is not configured", "encryption_unavailable");
      }
    }
    const { data: row, error } = await db
      .from("integration_connectors")
      .update(update)
      .eq("id", existing.id)
      .eq("workspace_id", actor.workspaceId)
      .neq("status", "revoked")
      .select(GITHUB_CONNECTOR_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new NotFoundError("No GitHub connector to update");
    view = toPublicGithubConnector(row as unknown as GithubConnectorRow, origin(request));
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "integration.connector.update",
      targetType: "integration_connector",
      targetId: existing.id,
      before: { kind: "github", status: existing.status },
      after: { kind: "github", status: view.status, secret_rotated: newSecret !== null },
    });
  }

  let rules = await loadWorkEventRules(db, actor.workspaceId);
  if (rulesPatch && rulesPatch.ok) {
    const before = rules;
    const next = normalizeRules({ ...rules, ...rulesPatch.rules });
    const { error } = await db.from("workspaces").update({ work_event_rules: next }).eq("id", actor.workspaceId);
    if (error) throw error;
    rules = next;
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "work_event_rules.update",
      targetType: "workspace",
      targetId: actor.workspaceId,
      before,
      after: next,
    });
  }

  return ok({ connector: view, rules, ...(newSecret ? { webhook_secret: newSecret } : {}) });
});

export const DELETE = route(async ({ actor, request }) => {
  assertIntegrationAdmin(actor);
  const db = createAdminClient();
  const existing = await getLiveGithubConnector(db, actor.workspaceId);
  if (!existing) throw new NotFoundError("No GitHub connector to revoke");
  const nowIso = new Date().toISOString();
  const { data: row, error } = await db
    .from("integration_connectors")
    .update({ status: "revoked", revoked_at: nowIso })
    .eq("id", existing.id)
    .eq("workspace_id", actor.workspaceId)
    .neq("status", "revoked")
    .select(GITHUB_CONNECTOR_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new RuleError("This connector is already revoked", "connector_revoked");
  const view = toPublicGithubConnector(row as unknown as GithubConnectorRow, origin(request));
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.connector.revoke",
    targetType: "integration_connector",
    targetId: existing.id,
    before: { kind: "github", status: existing.status },
    after: { kind: "github", status: "revoked" },
  });
  return ok(view);
});
