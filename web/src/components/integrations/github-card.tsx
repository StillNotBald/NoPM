"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import { formatRelativeTime } from "./format";
import { useApiResource } from "./hooks";
import { errorText } from "./model";
import { ConfirmDialog, CopyValue, Field, InlineAlert, LoadingRow, Select } from "./shared";

/**
 * GitHub work events (R-153, audit A1): a pull request opening or merging, or a deployment succeeding,
 * moves the task linked to it, instead of someone typing the status. One card: connect or revoke the
 * webhook (the secret is shown once), the webhook address to paste into GitHub, the status each event
 * moves a task to, and the last 20 events with what happened to each. Admins edit; everyone reads.
 */

type EventKind = "pr_opened" | "pr_merged" | "pr_closed" | "deploy_success" | "deploy_failure";
type Target = "unstarted" | "started" | "in_review" | "completed" | "canceled";
type Rules = Record<EventKind, Target | null>;

interface ConnectorSummary {
  id?: string;
  name: string;
  status: "active" | "paused" | "revoked";
  webhook_url?: string;
}
interface GithubSettings {
  connector: ConnectorSummary | null;
  can_manage: boolean;
  rules: Rules;
}
export interface WorkEventRow {
  id: string;
  kind: EventKind;
  ref: string;
  actor_login: string | null;
  received_at: string;
  applied: boolean;
  applied_status: string | null;
  reason: string;
}

const BASE = "/api/integrations/github";

export const RULE_ROWS: { kind: EventKind; label: string }[] = [
  { kind: "pr_opened", label: "Pull request opened" },
  { kind: "pr_merged", label: "Pull request merged" },
  { kind: "deploy_success", label: "Deployment succeeded" },
  { kind: "deploy_failure", label: "Deployment failed" },
];

export const TARGET_OPTIONS: { value: Target; label: string }[] = [
  { value: "unstarted", label: "Not started" },
  { value: "started", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "completed", label: "Completed" },
  { value: "canceled", label: "Canceled" },
];

const KIND_LABELS: Record<EventKind, string> = {
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  pr_closed: "PR closed",
  deploy_success: "Deploy succeeded",
  deploy_failure: "Deploy failed",
};

export const REASON_LABELS: Record<string, string> = {
  received: "Received",
  applied: "Task moved",
  project_locked: "Skipped: project is locked",
  unknown_ref: "No task linked to this pull request",
  no_rule: "No status set for this event",
  already_at_or_beyond: "Skipped: task is already past this status",
  task_canceled: "Skipped: task is canceled",
  conflict: "Skipped: task changed at the same time",
  no_linked_pr: "Deployment names no pull request",
  error: "Could not be applied",
};

async function fetchSettings(): Promise<GithubSettings> {
  return apiGet<GithubSettings>(`${BASE}/connector`);
}
async function fetchEvents(): Promise<WorkEventRow[]> {
  const rows = await apiGet<WorkEventRow[]>(`${BASE}/work-events?limit=20`);
  return Array.isArray(rows) ? rows : [];
}

export function EventRow({ event, nowMs }: { event: WorkEventRow; nowMs: number }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">
          <span className="font-medium">{KIND_LABELS[event.kind] ?? event.kind}</span>
          <span className="ml-2 break-all font-mono text-xs text-ink-secondary">{event.ref}</span>
        </p>
        <p className="text-xs text-ink-muted">
          {event.actor_login ? `${event.actor_login} · ` : ""}
          {formatRelativeTime(event.received_at, nowMs)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-0.5 sm:items-end">
        <Badge tone={event.applied ? "success" : "neutral"}>{event.applied ? "Applied" : "Not applied"}</Badge>
        <span className="text-xs text-ink-muted">
          {event.applied && event.applied_status ? `Now ${event.applied_status}` : (REASON_LABELS[event.reason] ?? event.reason)}
        </span>
      </div>
    </li>
  );
}

export function GithubCard() {
  const toast = useToast();
  const modal = useModal();
  const settings = useApiResource(fetchSettings);
  const events = useApiResource(fetchEvents);
  const [nowMs] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [draft, setDraft] = useState<Rules | null>(null);

  if (settings.state.status === "loading") {
    return (
      <Card>
        <CardBody>
          <LoadingRow label="Loading GitHub" />
        </CardBody>
      </Card>
    );
  }
  if (settings.state.status !== "ready") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardBody>
          <InlineAlert tone="neutral">GitHub work events are not available right now.</InlineAlert>
        </CardBody>
      </Card>
    );
  }

  const { connector, can_manage: canManage, rules: saved } = settings.state.data;
  const rules = draft ?? saved;
  const dirty = JSON.stringify(rules) !== JSON.stringify(saved);
  const reloadAll = () => {
    settings.reload();
    events.reload();
  };

  async function run<T>(action: () => Promise<T>, failure: string): Promise<T | null> {
    setBusy(true);
    try {
      return await action();
    } catch (e) {
      toast.error(errorText(e, failure));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    const r = await run(
      () => apiPost<{ webhook_secret: string }>(`${BASE}/connector`, name.trim() ? { name: name.trim() } : {}),
      "Could not connect GitHub.",
    );
    if (r) {
      setSecret(r.webhook_secret);
      setName("");
      toast.success("GitHub connected. Copy the secret now: it is shown once.");
      reloadAll();
    }
  }

  async function setStatus(status: "active" | "paused") {
    const r = await run(() => apiPatch(`${BASE}/connector`, { status }), "Could not change the connection.");
    if (r !== null) {
      toast.success(status === "paused" ? "GitHub events paused." : "GitHub events resumed.");
      reloadAll();
    }
  }

  async function rotate() {
    const r = await run(() => apiPatch<{ webhook_secret?: string }>(`${BASE}/connector`, { rotate_secret: true }), "Could not rotate the secret.");
    if (r?.webhook_secret) {
      setSecret(r.webhook_secret);
      toast.success("New secret created. Update it in GitHub: the old one no longer works.");
      reloadAll();
    }
  }

  async function saveRules() {
    const r = await run(() => apiPatch(`${BASE}/connector`, { rules }), "Could not save the status mapping.");
    if (r !== null) {
      toast.success("Status mapping saved.");
      setDraft(null);
      reloadAll();
    }
  }

  function askRevoke() {
    modal.open(
      <ConfirmDialog
        heading="Revoke the GitHub connection?"
        confirmLabel="Revoke connection"
        failureFallback="Could not revoke the connection."
        onConfirm={async () => {
          await apiDelete(`${BASE}/connector`);
          toast.success("GitHub connection revoked.");
          setSecret(null);
          reloadAll();
        }}
      >
        <p>GitHub deliveries are refused from now on and no task is moved. Past events stay listed. You can connect again later with a new secret.</p>
      </ConfirmDialog>,
    );
  }

  const list = events.state.status === "ready" ? events.state.data : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
      </CardHeader>
      <CardBody className="space-y-5">
        <p className="text-sm text-ink-secondary">
          Link a task to a pull request and its status follows the work: opening the pull request starts it, merging
          moves it to review, a successful deployment completes it. Only tasks whose pull request is linked are touched,
          never on a locked project, and every change is recorded in the audit trail as the GitHub connection.
        </p>

        {secret && (
          <div className="space-y-2 rounded-md border border-border-subtle bg-well p-3">
            <CopyValue label="Webhook secret (shown once)" value={secret} subject="the webhook secret" />
            <p className="text-xs text-ink-muted">Paste it into the GitHub webhook as the Secret. It cannot be shown again.</p>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
              I have copied it
            </Button>
          </div>
        )}

        {!connector ? (
          canManage ? (
            <div className="space-y-3">
              <Field id="github-name" label="Name" optional hint="Shown in the audit trail. Default: GitHub.">
                {(a11y) => (
                  <Input {...a11y} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={busy} className="w-full sm:w-72" />
                )}
              </Field>
              <Button size="sm" onClick={connect} disabled={busy}>
                {busy ? "Connecting..." : "Connect GitHub"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">GitHub is not connected. A workspace admin can connect it here.</p>
          )
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{connector.name}</span>
              <Badge tone={connector.status === "active" ? "success" : "warning"}>{connector.status === "active" ? "Active" : "Paused"}</Badge>
            </div>

            {canManage && connector.webhook_url && (
              <div className="space-y-3">
                <CopyValue label="Webhook address (Payload URL)" value={connector.webhook_url} subject="the webhook address" />
                <p className="text-xs text-ink-muted">
                  In the GitHub repository settings, add a webhook with this address, content type application/json, the
                  secret from when you connected, and the events Pull requests and Deployment statuses.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {connector.status === "active" ? (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus("paused")}>
                      Pause
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setStatus("active")}>
                      Resume
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" disabled={busy} onClick={rotate}>
                    Rotate secret
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={askRevoke}>
                    Revoke
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Status each event sets</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {RULE_ROWS.map(({ kind, label }) => (
              <Field key={kind} id={`github-rule-${kind}`} label={label}>
                {(a11y) => (
                  <Select
                    {...a11y}
                    value={rules[kind] ?? ""}
                    disabled={!canManage || busy}
                    onChange={(e) => setDraft({ ...rules, [kind]: e.target.value === "" ? null : (e.target.value as Target) })}
                  >
                    <option value="">Leave the task as it is</option>
                    {TARGET_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
          </div>
          <p className="text-xs text-ink-muted">A task only ever moves forward: an event never reopens a completed or canceled task.</p>
          {canManage ? (
            <Button size="sm" disabled={busy || !dirty} onClick={saveRules}>
              Save mapping
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">Only workspace admins can change the mapping.</p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Latest events</p>
          {events.state.status === "loading" ? (
            <LoadingRow label="Loading events" />
          ) : list.length === 0 ? (
            <p className="text-sm text-ink-muted">No GitHub events yet.</p>
          ) : (
            <ul className="space-y-2">
              {list.map((e) => (
                <EventRow key={e.id} event={e} nowMs={nowMs} />
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
