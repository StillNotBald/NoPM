"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { mintLinkCode, unlinkIdentity } from "./api";
import { formatCountdown, formatDate, linkMessage, remainingMs } from "./format";
import { useNow, type ResourceState } from "./hooks";
import { errorText, findMyIdentity, type ConnectorView, type IdentityView } from "./model";
import { CopyButton, InlineAlert, LoadingRow } from "./shared";

/** How often the identity list is re-checked while a link code is live (the bot link happens in another app). */
const LINK_POLL_MS = 4000;

type Mint = { code: string; expiresAt: number };

/**
 * "Your Lark account" (every member). Linking is by one-time code, never by
 * email match (PLAN D7): mint a code here, send `link <code>` to the NoPM bot
 * in a direct chat, and the bot event binds that verified Lark user to this
 * profile. While a code is live the card quietly re-checks the link so it
 * flips to "linked" the moment the bot confirms.
 */
export function LarkAccountCard({
  isAdmin,
  myProfileId,
  connector,
  connectorKnown,
  identities,
  onRetry,
  onReload,
}: {
  /** Admins are pointed at the connect form above rather than at "an admin". */
  isAdmin: boolean;
  myProfileId: string | null;
  /** The workspace's live connector, when this viewer is allowed to see it. */
  connector: ConnectorView | null;
  /** True when the connector lookup succeeded (so a null connector means "none", not "unknown"). */
  connectorKnown: boolean;
  identities: ResourceState<IdentityView[]>;
  onRetry: () => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const [mint, setMint] = useState<Mint | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const mine = identities.status === "ready" ? findMyIdentity(identities.data, myProfileId) : null;
  const linked = mine !== null;
  const codeLive = mint !== null && !linked;
  const now = useNow(codeLive);
  const left = mint ? remainingMs(mint.expiresAt, now) : 0;
  const expired = mint !== null && left <= 0;

  // Poll for the bot-side link while a live code is on screen.
  useEffect(() => {
    if (!codeLive || expired) return;
    const timer = setInterval(onReload, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [codeLive, expired, onReload]);

  // Celebrate the transition (not the initial load) from unlinked to linked.
  const wasLinked = useRef(linked);
  useEffect(() => {
    if (linked && !wasLinked.current && mint) toast.success("Lark account linked.");
    wasLinked.current = linked;
  }, [linked, mint, toast]);

  const connectorBlocksLinking = connectorKnown && (connector === null || connector.status !== "active");
  // One sentence that names the prerequisite (and where to meet it), instead of an alert PLUS a
  // faded, disabled button whose reason lives somewhere else.
  const prerequisite =
    connector === null
      ? isAdmin
        ? "Connect Lark in the card above first. Then you can link your own account here."
        : "You can link your account once a workspace admin has connected Lark."
      : isAdmin
        ? "Lark is paused. Resume it above, then link your account here."
        : "You can link your account once an admin resumes Lark.";

  async function handleMint() {
    setMinting(true);
    setMintError(null);
    try {
      setMint(await mintLinkCode(Date.now()));
    } catch (e) {
      setMintError(errorText(e, "Could not create a link code."));
    } finally {
      setMinting(false);
    }
  }

  async function handleUnlink() {
    if (!mine) return;
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await unlinkIdentity(mine.id);
      setMint(null);
      toast.success("Lark account unlinked.");
      onReload();
    } catch (e) {
      setUnlinkError(errorText(e, "Could not unlink your Lark account."));
    } finally {
      setUnlinking(false);
    }
  }

  let body: ReactNode;
  if (identities.status === "loading") {
    body = <LoadingRow label="Checking your Lark link…" />;
  } else if (identities.status === "unavailable") {
    body = <p className="text-sm text-ink-secondary">Lark linking isn&apos;t available on this deployment yet.</p>;
  } else if (identities.status === "forbidden") {
    body = <p className="text-sm text-ink-secondary">Your role can&apos;t link a Lark account.</p>;
  } else if (identities.status === "error") {
    body = (
      <div className="space-y-3">
        <InlineAlert>Could not load your Lark link: {identities.message}</InlineAlert>
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  } else if (mine) {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">linked</Badge>
          <p className="min-w-0 break-words text-sm text-ink">
            {mine.displayName ? <span className="font-medium">{mine.displayName}</span> : "Your Lark account"}
            <span className="text-ink-secondary"> · linked {formatDate(mine.linkedAt)}</span>
          </p>
        </div>
        <p className="text-sm text-ink-secondary">Approval requests assigned to you arrive in your Lark direct chat.</p>
        {unlinkError && <InlineAlert>{unlinkError}</InlineAlert>}
        <Button
          variant="secondary"
          size="sm"
          className="h-11 w-full sm:h-8 sm:w-auto"
          onClick={handleUnlink}
          disabled={unlinking}
        >
          {unlinking ? <Spinner size="sm" className="mr-1.5" /> : null}
          Unlink
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {connectorBlocksLinking ? (
          <p className="text-sm text-ink-secondary">{prerequisite}</p>
        ) : mint && !expired ? (
          <div className="space-y-3 rounded-lg border border-border-subtle bg-well p-4">
            <p className="text-sm text-ink">
              Open a direct chat with the NoPM bot in Lark and send this message:
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="block min-w-0 select-all break-all sm:flex-1 rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-sm text-ink">
                {linkMessage(mint.code)}
              </code>
              <CopyButton value={linkMessage(mint.code)} subject="link message" label="Copy message" />
            </div>
            <p className="text-xs text-ink-muted">
              Expires in <span className="font-mono tabular-nums text-ink-secondary">{formatCountdown(left)}</span>. Single
              use. This page updates when the bot confirms.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary">
              You&apos;ll get a one-time code to send to the NoPM bot in a direct chat in Lark.
            </p>
            {mint && expired && <InlineAlert tone="neutral">That code has expired. Create a new one.</InlineAlert>}
            {mintError && <InlineAlert>{mintError}</InlineAlert>}
            <Button
              variant="primary"
              size="md"
              className="h-11 w-full sm:h-10 sm:w-auto"
              onClick={handleMint}
              disabled={minting}
            >
              {minting ? (
                <>
                  <Spinner size="sm" className="mr-2" /> Creating code…
                </>
              ) : (
                "Link my Lark account"
              )}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Card id="lark-account">
      <CardHeader>
        <div>
          <CardTitle>Your Lark account</CardTitle>
          <p className="mt-0.5 text-xs text-ink-muted">So approval requests can reach you in chat.</p>
        </div>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
