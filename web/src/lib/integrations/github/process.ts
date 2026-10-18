import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/auth/guard";
import { applyTaskStatus, type StatusMoveTask } from "@/lib/work/apply-task-status";
import { MAX_EVENTS_PER_DELIVERY, parseGithubDelivery, type ParsedWorkEvent } from "./parse";
import { lookupCandidates } from "./refs";
import {
  IN_REVIEW_LABEL,
  RULE_TARGET_LABELS,
  normalizeRules,
  statusRank,
  targetRank,
  targetToStatus,
  type RuleTarget,
  type WorkEventRules,
} from "./rules";

/**
 * Apply one verified GitHub delivery (R-153, audit A1). Every event is first CLAIMED in `work_events`
 * (unique per connector + delivery + reference), so a redelivery changes nothing. A claimed event is then
 * matched to tasks whose `external_ref` equals `github:<owner>/<repo>#<number>`, and each matching task is
 * moved per the workspace rules only when:
 *   - its project is NOT locked (a locked project is skipped with one `work_event.skipped` audit row),
 *   - the move goes forward (never backwards, never out of completed or canceled),
 *   - nothing else changed the task since it was read (optimistic concurrency).
 * The move is the task PATCH write (`applyTaskStatus`): one `task.update` audit row, written as a connector
 * actor carrying via_connector_id, the delivery id and the GitHub login.
 */

export type GithubConnectorRef = { id: string; workspace_id: string; name: string };

export type WorkEventReason =
  | "received"
  | "applied"
  | "project_locked"
  | "unknown_ref"
  | "no_rule"
  | "already_at_or_beyond"
  | "task_canceled"
  | "conflict"
  | "no_linked_pr"
  | "replay"
  | "truncated"
  | "error";

export type DeliverySummary = {
  /** Events claimed and processed by this call. */
  recorded: number;
  /** Events skipped because the delivery was already recorded. */
  duplicates: number;
  /** Tasks whose status changed. */
  applied: number;
};

/** The audit actor for everything a delivery does: the connector, not a person. */
export function githubActor(connector: GithubConnectorRef, deliveryId: string, login: string | null): Actor {
  return {
    type: "token",
    id: connector.id,
    label: `github:${connector.name}`,
    workspaceId: connector.workspace_id,
    principalId: null,
    principalRole: null,
    channel: "github",
    viaConnectorId: connector.id,
    externalEventId: deliveryId,
    externalActorRef: `github:${login ?? "unknown"}`,
    requestId: crypto.randomUUID(),
  };
}

type Outcome = { reason: WorkEventReason; applied: boolean; taskId: string | null; appliedStatus: string | null };

export async function loadWorkEventRules(db: SupabaseClient, workspaceId: string): Promise<WorkEventRules> {
  const { data, error } = await db.from("workspaces").select("work_event_rules").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeRules((data as { work_event_rules?: unknown } | null)?.work_event_rules);
}

async function decide(
  db: SupabaseClient,
  connector: GithubConnectorRef,
  deliveryId: string,
  event: ParsedWorkEvent,
  rules: WorkEventRules,
): Promise<Outcome> {
  if (event.number === null) return { reason: "no_linked_pr", applied: false, taskId: null, appliedStatus: null };
  const [owner, repo] = event.repo.split("/");

  const { data: found, error } = await db
    .from("tasks")
    .select("*")
    .eq("workspace_id", connector.workspace_id)
    .in("external_ref", lookupCandidates({ owner, repo, number: event.number }))
    .limit(MAX_EVENTS_PER_DELIVERY);
  if (error) throw new Error(error.message);
  const tasks = (found ?? []) as StatusMoveTask[];
  if (tasks.length === 0) return { reason: "unknown_ref", applied: false, taskId: null, appliedStatus: null };

  const target: RuleTarget | null = rules[event.kind];
  if (!target) return { reason: "no_rule", applied: false, taskId: tasks[0].id, appliedStatus: null };
  const { statusType, label } = targetToStatus(target);

  let appliedAny = false;
  let skipReason: WorkEventReason = "already_at_or_beyond";
  let firstSkip = true;
  for (const task of tasks) {
    const note = (reason: WorkEventReason) => {
      if (firstSkip) skipReason = reason;
      firstSkip = false;
    };

    const current = statusRank(task.status_type, task.status);
    if (task.status_type === "canceled") {
      note("task_canceled");
      continue;
    }
    const forward = target === "canceled" ? task.status_type !== "completed" : current < targetRank(target);
    if (!forward) {
      note("already_at_or_beyond");
      continue;
    }

    const moved = await applyTaskStatus({
      db,
      actor: githubActor(connector, deliveryId, event.login),
      task,
      statusType,
      // "In review" is ours to set and to clear; any other label a person typed stays.
      statusLabel: label ?? (task.status === IN_REVIEW_LABEL ? null : undefined),
      skipContext: { kind: event.kind, ref: `${event.repo}#${event.number}` },
    });
    if (moved.ok) appliedAny = true;
    else note(moved.reason === "project_locked" ? "project_locked" : "conflict");
  }

  return {
    reason: appliedAny ? "applied" : skipReason,
    applied: appliedAny,
    taskId: tasks[0].id,
    appliedStatus: appliedAny ? RULE_TARGET_LABELS[target] : null,
  };
}

/** A body seen again under a different delivery id is a replay for this long. */
export const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function processGithubDelivery(args: {
  db: SupabaseClient;
  connector: GithubConnectorRef;
  deliveryId: string;
  eventName: string;
  payload: unknown;
  /** sha-256 (hex) of the raw request body. */
  bodyHash: string;
  now?: () => number;
}): Promise<DeliverySummary> {
  const { db, connector, deliveryId, bodyHash } = args;
  const parsed = parseGithubDelivery(args.eventName, args.payload);
  const summary: DeliverySummary = { recorded: 0, duplicates: 0, applied: 0 };
  if (parsed.length === 0) return summary;

  // The delivery id is a header the signature does not cover, so it alone cannot stop a captured signed body
  // being resent under a fresh id: the same body under ANOTHER delivery id within 24 hours is a replay.
  const since = new Date((args.now ?? Date.now)() - REPLAY_WINDOW_MS).toISOString();
  const { data: seen, error: seenError } = await db
    .from("work_events")
    .select("id")
    .eq("workspace_id", connector.workspace_id)
    .eq("connector_id", connector.id)
    .eq("body_hash", bodyHash)
    .neq("external_event_id", deliveryId)
    .gte("received_at", since)
    .limit(1);
  if (seenError) throw new Error(seenError.message);
  const replay = (seen ?? []).length > 0;

  const rules = replay ? null : await loadWorkEventRules(db, connector.workspace_id);

  for (const [index, event] of parsed.entries()) {
    const ref = event.number === null ? event.repo : `${event.repo}#${event.number}`;
    // Past the cap, or a replayed body: recorded for the trail, never acted on.
    const recordedOnly: WorkEventReason | null = replay ? "replay" : index >= MAX_EVENTS_PER_DELIVERY ? "truncated" : null;
    const { data: claim, error: claimError } = await db
      .from("work_events")
      .insert({
        workspace_id: connector.workspace_id,
        connector_id: connector.id,
        provider: "github",
        external_event_id: deliveryId,
        kind: event.kind,
        repo: event.repo,
        ref,
        actor_login: event.login,
        body_hash: bodyHash,
        ...(recordedOnly ? { reason: recordedOnly } : {}),
      })
      .select("id")
      .maybeSingle();
    if (claimError?.code === "23505") {
      summary.duplicates += 1;
      continue;
    }
    if (claimError || !claim) throw new Error(claimError?.message ?? "Could not record the work event");
    summary.recorded += 1;
    if (recordedOnly || !rules) continue;

    let outcome: Outcome;
    try {
      outcome = await decide(db, connector, deliveryId, event, rules);
    } catch (e) {
      console.error("[nopm][github] work event failed", { connector: connector.id, reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
      outcome = { reason: "error", applied: false, taskId: null, appliedStatus: null };
    }
    if (outcome.applied) summary.applied += 1;

    const { error: updateError } = await db
      .from("work_events")
      .update({
        task_id: outcome.taskId,
        applied: outcome.applied,
        applied_status: outcome.appliedStatus,
        reason: outcome.reason,
      })
      .eq("id", (claim as { id: string }).id)
      .eq("workspace_id", connector.workspace_id);
    if (updateError) console.error("[nopm][github] could not finalise work event", { connector: connector.id, error: updateError.message.slice(0, 200) });
  }
  return summary;
}
