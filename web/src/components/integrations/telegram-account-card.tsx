"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { unlinkIdentity } from "./api";
import { formatCountdown, formatDate, remainingMs } from "./format";
import { useNow, type ResourceState } from "./hooks";
import { errorText, findMyIdentity, type IdentityView } from "./model";
import { mintTelegramLinkCode } from "./telegram-api";
import { startMessage, type TelegramConnectorState, type TelegramLinkCode } from "./telegram-model";
import { CopyButton, InlineAlert, LoadingRow } from "./shared";

/** How often the link list is re-checked while a code is live (the link happens in the Telegram app). */
const LINK_POLL_MS = 4000;

/**
 * "Your Telegram account" (every member). Linking is by one-time code, never by
 * username: create a code here, open the t.me link (or send `/start <code>` to
 * the bot in a private chat), and the bot binds that verified Telegram user to
 * this profile. While a code is live the card re-checks the link so it flips
 * to "linked" the moment the bot confirms. A new code replaces the old one.
 * Everything passed in is already filtered to Telegram links.
 */
export function TelegramAccountCard({
  isAdmin,
  myProfileId,
  connector,
  connectorKnown,
  identities,
  onRetry,
  onReload,
}: {
  isAdmin: boolean;
  myProfileId: string | null;
  connector: TelegramConnectorState["connector"];
  /** True when the connector lookup succeeded (so a null connector means "none", not "unknown"). */
  connectorKnown: boolean;
  /** The member's own Telegram links only. */
  identities: ResourceState<IdentityView[]>;
  onRetry: () => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const [mint, setMint] = useState<TelegramLinkCode | null>(null);
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

  useEffect(() => {
    if (!codeLive || expired) return;
    const timer = setInterval(onReload, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [codeLive, expired, onReload]);

  const wasLinked = useRef(linked);
  useEffect(() => {
    if (linked && !wasLinked.current && mint) toast.success("Telegram account linked.");
    wasLinked.current = linked;
  }, [linked, mint, toast]);

  const blocked = connectorKnown && (connector === null || connector.status !== "active");
  const prerequisite =
    connector === null
      ? isAdmin
        ? "Connect Telegram in the card above first. Then link your account here."
        : "You can link once an admin has connected Telegram."
      : isAdmin
        ? "Telegram is disabled. Enable it above, then link here."
        : "You can link once an admin enables Telegram.";

  async function handleMint() {
    setMinting(true);
    setMintError(null);
    try {
      setMint(await mintTelegramLinkCode(Date.now()));
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
      toast.success("Telegram account unlinked.");
      onReload();
    } catch (e) {
      setUnlinkError(errorText(e, "Could not unlink your Telegram account."));
    } finally {
      setUnlinking(false);
    }
  }

  let body: ReactNode;
  if (identities.status === "loading") {
    body = <LoadingRow label="Checking your Telegram link…" />;
  } else if (identities.status === "unavailable") {
    body = <p className="text-sm text-ink-secondary">Telegram linking is not available here yet.</p>;
  } else if (identities.status === "forbidden") {
    body = <p className="text-sm text-ink-secondary">Your role cannot link a Telegram account.</p>;
  } else if (identities.status === "error") {
    body = (
      <div className="space-y-3">
        <InlineAlert>Could not load your Telegram link: {identities.message}</InlineAlert>
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
            <span className="font-medium">{mine.displayName ?? "Your Telegram account"}</span>
            <span className="text-ink-secondary"> · linked {formatDate(mine.linkedAt)}</span>
          </p>
        </div>
        <p className="text-sm text-ink-secondary">Send /0 to the bot in a private chat to see your menu. To use another Telegram account, unlink this one first.</p>
        {unlinkError && <InlineAlert>{unlinkError}</InlineAlert>}
        <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={handleUnlink} disabled={unlinking}>
          {unlinking ? <Spinner size="sm" className="mr-1.5" /> : null}
          Unlink
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {blocked ? (
          <p className="text-sm text-ink-secondary">{prerequisite}</p>
        ) : mint && !expired ? (
          <div className="space-y-3 rounded-lg border border-border-subtle bg-well p-4">
            <p className="text-sm text-ink">Open Telegram with this link, then tap Start:</p>
            {mint.deepLink && (
              <ButtonLink href={mint.deepLink} target="_blank" rel="noopener noreferrer" variant="primary" size="md" className="h-11 w-full sm:h-10 sm:w-auto">
                <ExternalLink size={14} className="mr-1.5" aria-hidden="true" />
                Open Telegram
              </ButtonLink>
            )}
            <p className="text-sm text-ink-secondary">{mint.deepLink ? "Or send this to the bot in a private chat:" : "Send this to the bot in a private chat:"}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="block min-w-0 select-all break-all rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-sm text-ink sm:flex-1">
                {startMessage(mint.code)}
              </code>
              <CopyButton value={startMessage(mint.code)} subject="link message" label="Copy message" />
            </div>
            {/* The ticking number is not announced every second; the text below is. */}
            <p className="text-xs text-ink-muted">
              Expires in <span className="font-mono tabular-nums text-ink-secondary">{formatCountdown(left)}</span>. Single use. This page updates when the bot confirms.
            </p>
            <p className="text-xs text-ink-muted">Creating a new code replaces this one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary">You get a one-time code, valid for 10 minutes, and a link that opens the bot.</p>
            {mint && expired && <InlineAlert tone="neutral">That code has expired. Create a new one.</InlineAlert>}
            {mintError && <InlineAlert>{mintError}</InlineAlert>}
            <Button variant="primary" size="md" className="h-11 w-full sm:h-10 sm:w-auto" onClick={handleMint} disabled={minting}>
              {minting ? (
                <>
                  <Spinner size="sm" className="mr-2" /> Creating code…
                </>
              ) : (
                "Link Telegram"
              )}
            </Button>
          </div>
        )}
        <span role="status" aria-live="polite" className="sr-only">
          {codeLive && !expired ? "Link code ready. It expires in 10 minutes." : codeLive && expired ? "The link code has expired." : ""}
        </span>
      </div>
    );
  }

  return (
    <Card id="telegram-account">
      <CardHeader>
        <div>
          <CardTitle>Your Telegram account</CardTitle>
          <p className="mt-0.5 text-xs text-ink-muted">Use the bot from your own chat.</p>
        </div>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
