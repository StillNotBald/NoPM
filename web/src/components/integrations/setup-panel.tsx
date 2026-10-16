"use client";

import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveAppUrl, resolveWebhookUrls, workerEnvBlock, type CallbackUrls } from "./format";
import { useOrigin } from "./hooks";
import type { LarkMode } from "./model";
import { CopyValue, InlineAlert } from "./shared";

/**
 * The two callback URLs for a hosted (webhook) connector. Not secret, so they
 * are shown both in the one-time setup panel and, on demand, from the
 * connected card — an admin re-pasting them into the developer console later
 * should not have to recreate the connection.
 *
 * Prefers the server-built `callback_urls` (they use the configured app URL
 * and are what the server will accept); falls back to this browser's address.
 * When the two name different hosts, a one-line hint says so.
 */
export function WebhookUrls({
  connectorId,
  serverUrls,
}: {
  connectorId: string;
  serverUrls: CallbackUrls | null;
}) {
  const origin = useOrigin();
  const urls = resolveWebhookUrls({ serverUrls, origin, connectorId });
  if (!urls) return null;
  return (
    <div className="space-y-3">
      <CopyValue label="Event request URL" value={urls.events} subject="event request URL" />
      <CopyValue label="Card callback URL" value={urls.card} subject="card callback URL" />
      {urls.hint && <InlineAlert tone="neutral">{urls.hint}</InlineAlert>}
    </div>
  );
}

/**
 * Shown once, straight after a connector is created. For a long-connection
 * connector it carries the relay secret (the API returns it exactly once);
 * for a webhook connector it carries the URLs to paste into the Lark
 * developer console. Dismissing it discards the secret from page state.
 */
export function SetupPanel({
  connectorId,
  mode,
  relaySecret,
  serverUrls,
  onDismiss,
}: {
  connectorId: string;
  mode: LarkMode;
  relaySecret: string | null;
  serverUrls: CallbackUrls | null;
  onDismiss: () => void;
}) {
  const origin = useOrigin();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the new panel so keyboard/screen-reader users land on the next step.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const showsSecret = mode === "long_connection" && relaySecret !== null;
  const appUrl = resolveAppUrl({ serverUrls, origin });

  return (
    <section
      aria-labelledby="lark-setup-heading"
      className="space-y-4 rounded-lg border border-border-subtle bg-sunken p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4
          id="lark-setup-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-ink focus:outline-none"
        >
          {mode === "webhook" ? "Finish setup in the Lark developer console" : "Start the relay worker"}
        </h4>
        {showsSecret && <Badge tone="warning">Shown once — copy it now.</Badge>}
      </div>

      {mode === "webhook" ? (
        <>
          <p className="text-sm text-ink-secondary">
            In your app&apos;s Events &amp; Callbacks settings, pick the developer-server (webhook) subscription
            mode and paste the event URL, then paste the card URL in the callback settings.
          </p>
          <WebhookUrls connectorId={connectorId} serverUrls={serverUrls} />
        </>
      ) : (
        <>
          <p className="text-sm text-ink-secondary">
            In the Lark developer console pick the persistent (long) connection subscription mode, then run the
            relay worker (<code className="font-mono text-xs">npm run lark:worker</code>, one instance
            only) with these values plus your <code className="font-mono text-xs">LARK_APP_ID</code>,{" "}
            <code className="font-mono text-xs">LARK_APP_SECRET</code> and{" "}
            <code className="font-mono text-xs">LARK_REGION</code>.
          </p>
          {appUrl && (
            <CopyValue
              label="Worker environment"
              value={workerEnvBlock({ origin: appUrl, connectorId, relaySecret })}
              subject="worker environment"
              multiline
            />
          )}
        </>
      )}

      <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onDismiss}>
        {showsSecret ? "I've saved it" : "Done"}
      </Button>
    </section>
  );
}
