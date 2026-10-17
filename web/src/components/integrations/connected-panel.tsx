"use client";

import { useState, type ReactNode } from "react";
import { Pause, Play, PlugZap, RotateCw, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  clearTenantPin,
  requeueDeadCards,
  revokeConnector,
  sendDigestNow,
  setConnectorStatus,
  testConnector,
  updateConnectorSettings,
} from "./api";
import { FeatureFields } from "./feature-fields";
import { WEEKDAYS, pluralise, resolveAppUrl, workerEnvBlock, type CallbackUrls } from "./format";
import { useNow, useOrigin } from "./hooks";
import {
  MODE_LABEL,
  REGION_LABEL,
  digestOutcome,
  errorText,
  featuresFromConnector,
  requeueOutcome,
  summariseDeliveryHealth,
  validateFeatures,
  type ConnectorView,
  type FeatureValues,
  type FormErrors,
} from "./model";
import { ConfirmDialog, CopyValue, Disclosure, InlineAlert } from "./shared";
import { WebhookUrls } from "./setup-panel";

type Busy = "test" | "digest" | "requeue" | "status" | "settings" | null;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

const HEALTH_LABEL = { success: "Healthy", warning: "Retrying", danger: "Failing", neutral: "Idle" } as const;

// One quiet status line (a dot and plain words), not a pill: it only draws the eye when something is wrong.
const HEALTH_DOT = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-border-strong",
} as const;
const HEALTH_INK = {
  success: "text-success-ink",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
  neutral: "text-ink-secondary",
} as const;

/**
 * The connected state of the Lark card (admin): status, the non-secret facts,
 * delivery health when the API provides it, and the five things an admin
 * actually does — test, send the digest now, pause/resume, edit settings,
 * revoke. Secrets are never displayed here; they are not retrievable.
 */
export function ConnectedPanel({
  connector,
  serverUrls,
  linkedTotal,
  onChanged,
}: {
  connector: ConnectorView;
  /** Server-built callback URLs remembered from the create response, used when the list read omits them. */
  serverUrls: CallbackUrls | null;
  /** Active Lark links across the workspace (admins see everyone's), or null if unknown. */
  linkedTotal: number | null;
  /** Called after any successful change; `"revoked"` tells the card to forget one-time setup state. */
  onChanged: (change?: "revoked") => void;
}) {
  const toast = useToast();
  const modal = useModal();
  const origin = useOrigin();
  const now = useNow(true, 60_000);
  const callbackUrls = connector.callbackUrls ?? serverUrls;
  const appUrl = resolveAppUrl({ serverUrls: callbackUrls, origin });

  const [busy, setBusy] = useState<Busy>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [features, setFeatures] = useState<FeatureValues>(() => featuresFromConnector(connector));
  const [featureErrors, setFeatureErrors] = useState<FormErrors<FeatureValues>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const paused = connector.status === "paused";
  const digestReady = connector.digest.enabled && Boolean(connector.digest.chatId);
  const health = connector.health ? summariseDeliveryHealth(connector.health, now) : null;

  async function runTest() {
    setBusy("test");
    setTestResult(null);
    try {
      const result = await testConnector(connector.id);
      setTestResult(
        result.ok
          ? { ok: true, text: result.botName ? `Connected as ${result.botName}.` : "Lark accepted the credentials." }
          : { ok: false, text: result.error ?? "Lark rejected these credentials." },
      );
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e, "Could not reach Lark.") });
    } finally {
      setBusy(null);
    }
  }

  async function runDigest() {
    setBusy("digest");
    try {
      const outcome = digestOutcome(await sendDigestNow(connector.id));
      toast[outcome.tone](outcome.message);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not send the digest."));
    } finally {
      setBusy(null);
    }
  }

  async function runRequeue() {
    setBusy("requeue");
    try {
      const outcome = requeueOutcome(await requeueDeadCards(connector.id));
      toast[outcome.tone](outcome.message);
      onChanged();
    } catch (e) {
      toast.error(errorText(e, "Could not send the failed cards again."));
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus() {
    const next = paused ? "active" : "paused";
    setBusy("status");
    try {
      await setConnectorStatus(connector.id, next);
      toast.success(next === "paused" ? "Lark paused." : "Lark resumed.");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, next === "paused" ? "Could not pause Lark." : "Could not resume Lark."));
    } finally {
      setBusy(null);
    }
  }

  function startEditing() {
    setFeatures(featuresFromConnector(connector));
    setFeatureErrors({});
    setSettingsError(null);
    setEditing(true);
  }

  async function saveSettings() {
    const found = validateFeatures(features);
    setFeatureErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy("settings");
    setSettingsError(null);
    try {
      await updateConnectorSettings(connector.id, features);
      toast.success("Lark settings saved.");
      setEditing(false);
      onChanged();
    } catch (e) {
      setSettingsError(errorText(e, "Could not save settings."));
    } finally {
      setBusy(null);
    }
  }

  function askClearLock() {
    modal.open(
      <ConfirmDialog
        heading="Clear the Lark workspace lock?"
        confirmLabel="Clear lock"
        failureFallback="Could not clear the lock."
        onConfirm={async () => {
          await clearTenantPin(connector.id);
          toast.success("Workspace lock cleared. The next account link will lock it again.");
          onChanged();
        }}
      >
        <p>
          This connection is locked to the first Lark workspace that linked an account, so people from any other
          Lark workspace can&apos;t link to it.
        </p>
        <p>
          Clearing the lock lets the next account that links choose the workspace, and the connection locks to it
          again. Use this only if you moved to a different Lark workspace.
        </p>
      </ConfirmDialog>,
      { title: "Clear workspace lock", size: "sm" },
    );
  }

  function askRevoke() {
    modal.open(
      <ConfirmDialog
        heading="Revoke this Lark connection?"
        confirmLabel="Revoke connection"
        failureFallback="Could not revoke the connection."
        onConfirm={async () => {
          await revokeConnector(connector.id);
          toast.success("Lark connection revoked.");
          onChanged("revoked");
        }}
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>Messages to Lark stop immediately, and anything still queued is dropped.</li>
          <li>
            {linkedTotal !== null && linkedTotal > 0
              ? `${pluralise(linkedTotal, "linked Lark account")} will be unlinked and each member has to link again after you reconnect.`
              : "Every linked Lark account is unlinked, and members have to link again after you reconnect."}
          </li>
          <li>Approve and Reject buttons on cards already in chat stop working. Decide in NoPM instead.</li>
          <li>Decisions already made from Lark stay in the Trust Center.</li>
        </ul>
      </ConfirmDialog>,
      { title: "Revoke Lark connection", size: "sm" },
    );
  }

  const digestSummary = connector.digest.enabled
    ? `${WEEKDAYS[connector.digest.weekday]}s (UTC)${connector.digest.chatId ? "" : " — no group chat set"}`
    : "Off";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-ink">{connector.name}</p>
        <Badge tone={paused ? "warning" : "success"}>{connector.status}</Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label="Region">{REGION_LABEL[connector.region]}</Fact>
        <Fact label="Mode">{MODE_LABEL[connector.mode]}</Fact>
        <Fact label="App ID">
          <span className="font-mono text-xs">{connector.appId || "—"}</span>
        </Fact>
        <Fact label="Approvals from chat">{connector.approvalsEnabled ? "On" : "Off"}</Fact>
        <Fact label="Weekly digest">
          {digestSummary}
          {connector.digest.enabled && connector.digest.chatId && (
            <span className="ml-1.5 font-mono text-xs text-ink-secondary">{connector.digest.chatId}</span>
          )}
        </Fact>
        <Fact label="Incoming events">
          {connector.hasEncryptKey ? "Signed and encrypted" : "Verification token only"}
        </Fact>
        {linkedTotal !== null && (
          <Fact label="Linked accounts">
            {linkedTotal === 0 ? "Nobody has linked yet" : pluralise(linkedTotal, "member") + " linked"}
          </Fact>
        )}
      </dl>

      {connector.tenantPinned && (
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-ink-muted">
          <span>Locked to the first Lark workspace that linked an account.</span>
          <button
            type="button"
            onClick={askClearLock}
            disabled={busy !== null}
            className="focus-ring inline-flex min-h-[44px] items-center rounded-sm font-medium text-accent hover:underline disabled:pointer-events-none disabled:opacity-50 sm:min-h-0"
          >
            Clear lock
          </button>
        </p>
      )}

      {health && (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-secondary">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", HEALTH_DOT[health.tone])} aria-hidden="true" />
            <span className={cn("font-medium", HEALTH_INK[health.tone])}>{HEALTH_LABEL[health.tone]}</span>
            <span>{health.text}</span>
          </p>
          {connector.health?.lastError && health.tone !== "success" && (
            <p className="break-words text-xs text-ink-muted">Last error: {connector.health.lastError}</p>
          )}
        </div>
      )}

      {connector.health?.schedulerStale === true && (
        <InlineAlert>
          The daily scheduler has not run for this connection for over 36 hours, so retries and the weekly digest are
          stalled. Check that the cron job is still configured on your host.
        </InlineAlert>
      )}

      {!connector.secretsReadable && (
        <InlineAlert>
          This server can no longer decrypt the stored Lark credentials (the encryption key changed). Revoke this
          connection and connect again.
        </InlineAlert>
      )}

      {paused && (
        <InlineAlert tone="neutral">
          Paused. Nothing is sent to Lark and chat buttons are ignored until you resume.
        </InlineAlert>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={runTest}
          disabled={busy !== null}
        >
          {busy === "test" ? <Spinner size="sm" className="mr-1.5" /> : <PlugZap size={14} className="mr-1.5" aria-hidden="true" />}
          Test connection
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={runDigest}
          disabled={busy !== null || paused || !digestReady}
        >
          {busy === "digest" ? <Spinner size="sm" className="mr-1.5" /> : <Send size={14} className="mr-1.5" aria-hidden="true" />}
          Send digest now
        </Button>
        {(connector.health?.dead ?? 0) > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={runRequeue}
            disabled={busy !== null || paused}
          >
            {busy === "requeue" ? <Spinner size="sm" className="mr-1.5" /> : <RotateCw size={14} className="mr-1.5" aria-hidden="true" />}
            Requeue failed cards
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={toggleStatus}
          disabled={busy !== null}
        >
          {busy === "status" ? (
            <Spinner size="sm" className="mr-1.5" />
          ) : paused ? (
            <Play size={14} className="mr-1.5" aria-hidden="true" />
          ) : (
            <Pause size={14} className="mr-1.5" aria-hidden="true" />
          )}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={startEditing}
          disabled={busy !== null || editing}
        >
          Edit settings
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 w-full text-danger-ink hover:bg-danger/10 sm:ml-auto sm:h-8 sm:w-auto"
          onClick={askRevoke}
          disabled={busy !== null}
        >
          Revoke
        </Button>
      </div>

      {!digestReady && (
        <p className="text-xs text-ink-muted">
          To send a digest, turn on the weekly digest and set a group chat in Edit settings.
        </p>
      )}

      {testResult && <InlineAlert tone={testResult.ok ? "success" : "danger"}>{testResult.text}</InlineAlert>}

      {editing && (
        <section aria-label="Edit Lark settings" className="space-y-4 rounded-lg border border-border-subtle bg-sunken p-4">
          <FeatureFields
            values={features}
            onChange={(patch) => setFeatures((f) => ({ ...f, ...patch }))}
            errors={featureErrors}
            disabled={busy === "settings"}
            idPrefix="lark-edit"
          />
          {settingsError && <InlineAlert>{settingsError}</InlineAlert>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="ghost"
              size="sm"
              className="h-11 sm:h-8"
              onClick={() => setEditing(false)}
              disabled={busy === "settings"}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="h-11 sm:h-8"
              onClick={saveSettings}
              disabled={busy === "settings"}
            >
              {busy === "settings" ? (
                <>
                  <Spinner size="sm" className="mr-1.5" /> Saving…
                </>
              ) : (
                "Save settings"
              )}
            </Button>
          </div>
        </section>
      )}

      <Disclosure summary="Lark developer console setup">
        {connector.mode === "webhook" ? (
          <>
            <p className="text-sm text-ink-secondary">
              Paste these into your app&apos;s Events &amp; Callbacks settings. They are not secret.
            </p>
            <WebhookUrls connectorId={connector.id} serverUrls={callbackUrls} />
          </>
        ) : (
          <>
            <p className="text-sm text-ink-secondary">
              The relay worker needs these values. The relay secret was shown once when you connected; if it is
              lost, revoke and reconnect to get a new one.
            </p>
            {appUrl && (
              <CopyValue
                label="Worker environment"
                value={workerEnvBlock({ origin: appUrl, connectorId: connector.id })}
                subject="worker environment"
                multiline
              />
            )}
          </>
        )}
      </Disclosure>
    </div>
  );
}
