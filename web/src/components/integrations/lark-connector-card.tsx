"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectForm } from "./connect-form";
import { ConnectedPanel } from "./connected-panel";
import type { ResourceState } from "./hooks";
import type { CallbackUrls } from "./format";
import { MODE_LABEL, REGION_LABEL, readOnlySummary, type ConnectorView, type LarkMode } from "./model";
import { InlineAlert, LoadingRow } from "./shared";
import { SetupPanel } from "./setup-panel";

interface CreatedSetup {
  mode: LarkMode;
  relaySecret: string | null;
  connector: ConnectorView | null;
}

/**
 * Non-admin view: a read-only status line, never a control. It is built only
 * from the redacted connector the API gives members (status, region, mode and
 * the approvals / digest switches — no app id, chat id or secrets).
 */
function ReadOnlyStatus({ connector }: { connector: ConnectorView | null }) {
  if (!connector) {
    return (
      <p className="text-sm text-ink-secondary">
        Lark isn&apos;t connected for this workspace. A workspace admin can connect it from this page.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-sm text-ink">{readOnlySummary(connector)}</p>
      <p className="text-xs text-ink-muted">
        {REGION_LABEL[connector.region]} · {MODE_LABEL[connector.mode]}. Only workspace admins can change this
        connection.
      </p>
    </div>
  );
}

/**
 * The "Lark / Feishu" card. Admins connect, test, pause and revoke; everyone
 * else sees a read-only status line from the redacted connector view. A 403
 * (kept as a safety net should the redacted view ever be withdrawn) renders as
 * calm explanatory copy and a 404 as "not available on this deployment" —
 * neither is shown as an error.
 */
export function LarkConnectorCard({
  isAdmin,
  resource,
  linkedTotal,
  onRetry,
  onChanged,
}: {
  /** null while /api/me is still loading. */
  isAdmin: boolean | null;
  resource: ResourceState<ConnectorView | null>;
  linkedTotal: number | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  // One-time values from the create call (relay secret). Held only until dismissed or revoked.
  const [created, setCreated] = useState<CreatedSetup | null>(null);
  // Server-built callback URLs from the create response (not secret). Kept after the setup panel is
  // dismissed so the connected card keeps showing what the server will accept; lost on reload, when
  // the list read either returns them or the browser address is used.
  const [knownUrls, setKnownUrls] = useState<{ connectorId: string; urls: CallbackUrls } | null>(null);

  let body: ReactNode;
  if (resource.status === "loading" || isAdmin === null) {
    body = <LoadingRow label="Loading the Lark connection…" />;
  } else if (resource.status === "unavailable") {
    body = (
      <p className="text-sm text-ink-secondary">
        Integrations aren&apos;t available on this deployment yet.
      </p>
    );
  } else if (resource.status === "forbidden") {
    body = (
      <p className="text-sm text-ink-secondary">
        Only workspace admins can see or change the Lark connection. Once an admin has connected it, link your own
        account below to receive approval requests in chat.
      </p>
    );
  } else if (resource.status === "error") {
    body = (
      <div className="space-y-3">
        <InlineAlert>Could not load the Lark connection: {resource.message}</InlineAlert>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  } else {
    const connector = resource.data ?? created?.connector ?? null;
    if (!isAdmin) {
      body = <ReadOnlyStatus connector={connector} />;
    } else if (!connector) {
      body = showForm ? (
        <ConnectForm
          onCancel={() => setShowForm(false)}
          onCreated={(result) => {
            setCreated(result);
            const urls = result.connector?.callbackUrls;
            setKnownUrls(result.connector && urls ? { connectorId: result.connector.id, urls } : null);
            setShowForm(false);
            onChanged();
          }}
        />
      ) : (
        // Compact on purpose: one line of value, what to bring from Lark, and the button.
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-ink">
              Approve or reject deletion and change requests from a chat card. Every decision is still recorded once in
              the Trust Center.
            </p>
            <p className="text-xs text-ink-muted">
              You&apos;ll need a self-built app from the Lark developer console: its App ID, App Secret and Verification
              Token (plus an Encrypt Key for a webhook).
            </p>
          </div>
          <Button
            variant="primary"
            size="md"
            className="h-11 w-full shrink-0 sm:h-10 sm:w-auto"
            onClick={() => setShowForm(true)}
          >
            Connect Lark or Feishu
          </Button>
        </div>
      );
    } else {
      const serverUrls =
        connector.callbackUrls ?? (knownUrls?.connectorId === connector.id ? knownUrls.urls : null);
      body = (
        <div className="space-y-5">
          {created && (
            <SetupPanel
              connectorId={connector.id}
              mode={created.mode}
              relaySecret={created.relaySecret}
              serverUrls={serverUrls}
              onDismiss={() => setCreated(null)}
            />
          )}
          <ConnectedPanel
            connector={connector}
            serverUrls={serverUrls}
            linkedTotal={linkedTotal}
            onChanged={(change) => {
              if (change === "revoked") {
                setCreated(null);
                setKnownUrls(null);
                setShowForm(false);
              }
              onChanged();
            }}
          />
        </div>
      );
    }
  }

  return (
    <Card id="lark">
      <CardHeader>
        <div>
          <CardTitle>Lark / Feishu</CardTitle>
          <p className="mt-0.5 text-xs text-ink-muted">Approve from chat and get a weekly portfolio digest.</p>
        </div>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
