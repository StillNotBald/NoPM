"use client";

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Pause, Play, PlugZap, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "./format";
import { useApiResource, useNow, type ResourceState } from "./hooks";
import { errorText } from "./model";
import { ConfirmDialog, Field, InlineAlert, LoadingRow } from "./shared";
import {
  connectTelegram,
  disconnectTelegram,
  fetchTelegramStatus,
  registerTelegram,
  sendTelegramTest,
  setTelegramStatus,
} from "./telegram-api";
import {
  WEBHOOK_STEP_LABEL,
  validateBotToken,
  type RegistrationResult,
  type TelegramConnectorState,
  type TelegramConnectorView,
} from "./telegram-model";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

/** Short, plain steps. The token is pasted below and never shown again. */
function HowToCreate() {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted">How to create a bot</p>
      <ol className="list-decimal space-y-0.5 pl-5 text-sm text-ink-secondary">
        <li>
          In Telegram, open <span className="font-mono text-xs text-ink">@BotFather</span>.
        </li>
        <li>
          Send <span className="font-mono text-xs text-ink">/newbot</span> and choose a name and a username.
        </li>
        <li>Copy the token BotFather replies with and paste it below.</li>
      </ol>
    </div>
  );
}

function ConnectForm({ onConnected }: { onConnected: (registration: RegistrationResult) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateBotToken(token);
    setError(invalid ?? undefined);
    setFailure(null);
    if (invalid) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await connectTelegram(token);
      setToken(""); // write-only: dropped from the page the moment it is sent
      onConnected(result.registration);
    } catch (err) {
      setFailure(errorText(err, "Could not connect the bot."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <HowToCreate />
      <Field
        id="telegram-token"
        label="Bot token"
        error={error}
        hint="Stored encrypted. It is never shown again, so keep your own copy in BotFather."
      >
        {(a11y) => (
          <Input
            {...a11y}
            ref={inputRef}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            className="font-mono"
          />
        )}
      </Field>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      <Button type="submit" variant="primary" size="md" className="h-11 w-full sm:h-10 sm:w-auto" disabled={busy}>
        {busy ? (
          <>
            <Spinner size="sm" className="mr-2" /> Connecting…
          </>
        ) : (
          "Connect Telegram"
        )}
      </Button>
    </form>
  );
}

type Busy = "test" | "status" | "register" | null;

function ConnectedPanel({
  connector,
  registration,
  onChanged,
}: {
  connector: TelegramConnectorView;
  /** The registration result of the create call, until it is replaced by a later check. */
  registration: RegistrationResult | null;
  onChanged: (change?: "disconnected") => void;
}) {
  const toast = useToast();
  const modal = useModal();
  const now = useNow(true, 60_000);
  const fetchStatus = useCallback(() => fetchTelegramStatus(connector.id), [connector.id]);
  const status = useApiResource(fetchStatus);
  const [busy, setBusy] = useState<Busy>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const paused = connector.status === "paused";

  async function runTest() {
    setBusy("test");
    setTestResult(null);
    try {
      const r = await sendTelegramTest(connector.id);
      setTestResult(r.ok ? { ok: true, text: "Sent. Check your own Telegram chat with the bot." } : { ok: false, text: r.error ?? "Telegram did not deliver the message." });
    } catch (e) {
      setTestResult({ ok: false, text: errorText(e, "Could not send the test message.") });
    } finally {
      setBusy(null);
    }
  }

  async function runRegister() {
    setBusy("register");
    try {
      const r = await registerTelegram(connector.id);
      if (r.ok) toast.success("Webhook and menu registered.");
      else toast.error(r.error ?? "Telegram did not accept the setup.");
      status.reload();
    } catch (e) {
      toast.error(errorText(e, "Could not register the bot."));
    } finally {
      setBusy(null);
    }
  }

  async function toggleStatus() {
    const next = paused ? "active" : "paused";
    setBusy("status");
    try {
      await setTelegramStatus(next);
      toast.success(next === "paused" ? "Telegram disabled." : "Telegram enabled.");
      onChanged();
    } catch (e) {
      toast.error(errorText(e, next === "paused" ? "Could not disable Telegram." : "Could not enable Telegram."));
    } finally {
      setBusy(null);
    }
  }

  function askDisconnect() {
    modal.open(
      <ConfirmDialog
        heading="Disconnect this Telegram bot?"
        confirmLabel="Disconnect bot"
        failureFallback="Could not disconnect the bot."
        onConfirm={async () => {
          await disconnectTelegram();
          toast.success("Telegram bot disconnected.");
          onChanged("disconnected");
        }}
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>The bot token is erased from NoPM and the webhook is removed.</li>
          <li>Every linked Telegram account is unlinked. Members must link again after you reconnect.</li>
          <li>Open steps in chats are dropped.</li>
          <li>Past decisions stay in the Trust Center.</li>
        </ul>
      </ConfirmDialog>,
      { title: "Disconnect Telegram", size: "sm" },
    );
  }

  let webhook: ReactNode;
  if (status.state.status === "loading") {
    webhook = <LoadingRow label="Checking the webhook…" />;
  } else if (status.state.status === "ready") {
    const s = status.state.data;
    webhook = (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-secondary" role="status">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", s.webhook === "ok" ? "bg-success" : "bg-danger")} aria-hidden="true" />
        <span className={cn("font-medium", s.webhook === "ok" ? "text-success-ink" : "text-danger-ink")}>{s.webhook === "ok" ? "Webhook OK" : "Webhook error"}</span>
        {s.detail && <span className="break-words">{s.detail}</span>}
      </p>
    );
  } else {
    webhook = <InlineAlert>Could not check the webhook: {status.state.message}</InlineAlert>;
  }
  const lastUpdate = status.state.status === "ready" ? formatRelativeTime(status.state.data.lastUpdateAt, now) : "—";
  const pending = status.state.status === "ready" ? status.state.data.pendingUpdates : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-ink">{connector.name}</p>
        <Badge tone={paused ? "warning" : "success"}>{connector.status}</Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label="Bot">
          <span className="font-mono text-xs">{connector.botUsername ? `@${connector.botUsername}` : "—"}</span>
        </Fact>
        <Fact label="Last update received">{lastUpdate}</Fact>
        {pending !== null && pending > 0 && <Fact label="Waiting at Telegram">{pending}</Fact>}
      </dl>

      {registration && !registration.ok && (
        <InlineAlert>
          {WEBHOOK_STEP_LABEL[registration.step] ?? "Setup did not finish"}: {registration.error} Use Reconnect to try again.
        </InlineAlert>
      )}

      {webhook}

      {paused && <InlineAlert tone="neutral">Disabled. The bot answers every chat with “turned off” and keeps open steps until you enable it.</InlineAlert>}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={runTest} disabled={busy !== null || paused}>
          {busy === "test" ? <Spinner size="sm" className="mr-1.5" /> : <PlugZap size={14} className="mr-1.5" aria-hidden="true" />}
          Send test to me
        </Button>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={runRegister} disabled={busy !== null}>
          {busy === "register" ? <Spinner size="sm" className="mr-1.5" /> : <RefreshCw size={14} className="mr-1.5" aria-hidden="true" />}
          Reconnect
        </Button>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={toggleStatus} disabled={busy !== null}>
          {busy === "status" ? <Spinner size="sm" className="mr-1.5" /> : paused ? <Play size={14} className="mr-1.5" aria-hidden="true" /> : <Pause size={14} className="mr-1.5" aria-hidden="true" />}
          {paused ? "Enable" : "Disable"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 w-full text-danger-ink hover:bg-danger/10 sm:ml-auto sm:h-8 sm:w-auto"
          onClick={askDisconnect}
          disabled={busy !== null}
        >
          Disconnect
        </Button>
      </div>
      {paused && <p className="text-xs text-ink-muted">To send yourself a test, enable the bot first.</p>}

      {testResult && <InlineAlert tone={testResult.ok ? "success" : "danger"}>{testResult.text}</InlineAlert>}
    </div>
  );
}

/**
 * The "Telegram" card. Admins connect (paste the BotFather token), check the
 * webhook, test, disable and disconnect; everyone else sees a read-only status
 * line. A 403 renders as calm copy and a 404 as "not available here", never as
 * an error. The token is write-only: it is not part of any view type.
 */
export function TelegramConnectorCard({
  isAdmin,
  resource,
  onRetry,
  onChanged,
}: {
  /** null while /api/me is still loading. */
  isAdmin: boolean | null;
  resource: ResourceState<TelegramConnectorState>;
  onRetry: () => void;
  onChanged: () => void;
}) {
  // Result of the create call, kept so a half-finished setup is explained until the next check.
  const [registration, setRegistration] = useState<RegistrationResult | null>(null);

  let body: ReactNode;
  if (resource.status === "loading" || isAdmin === null) {
    body = <LoadingRow label="Loading the Telegram connection…" />;
  } else if (resource.status === "unavailable") {
    body = <p className="text-sm text-ink-secondary">Telegram is not available here yet.</p>;
  } else if (resource.status === "forbidden") {
    body = <p className="text-sm text-ink-secondary">Only workspace admins can see the Telegram connection. Once it is connected, link your own account below.</p>;
  } else if (resource.status === "error") {
    body = (
      <div className="space-y-3">
        <InlineAlert>Could not load the Telegram connection: {resource.message}</InlineAlert>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  } else {
    const { connector } = resource.data;
    if (!isAdmin) {
      body = connector ? (
        <div className="space-y-1">
          <p className="text-sm text-ink">{connector.status === "active" ? "Telegram is connected." : "Telegram is disabled."}</p>
          <p className="text-xs text-ink-muted">Only workspace admins can change it.</p>
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">Telegram is not connected. A workspace admin can connect it here.</p>
      );
    } else if (!connector) {
      body = (
        <ConnectForm
          onConnected={(r) => {
            setRegistration(r);
            onChanged();
          }}
        />
      );
    } else {
      body = (
        <ConnectedPanel
          connector={connector}
          registration={registration}
          onChanged={(change) => {
            if (change === "disconnected") setRegistration(null);
            onChanged();
          }}
        />
      );
    }
  }

  return (
    <Card id="telegram">
      <CardHeader>
        <div>
          <CardTitle>Telegram</CardTitle>
          <p className="mt-0.5 text-xs text-ink-muted">Work and approvals from a private chat with your bot.</p>
        </div>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
