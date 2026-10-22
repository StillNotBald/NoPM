"use client";

import { useEffect, useId, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ExportCsvButton } from "@/components/export-csv-button";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { FourEyesNote } from "@/components/governance/four-eyes-note";
import { ShowOncePanel } from "@/components/governance/show-once-panel";
import { ConfirmDialog, CopyButton, CopyValue, Disclosure, Field, InlineAlert } from "@/components/integrations/shared";
import { cn } from "@/lib/cn";
import { apiDelete, apiGet, apiPost } from "@/lib/api-client";
import { useRequireSession } from "@/lib/auth/use-require-session";
import { AGENT_PRESET_SCOPES, scopeChoices } from "@/lib/auth/scopes";

/** Groups an already resource-ordered flat scope list (scopeChoices()'
 *  output) back into per-resource buckets for the mobile collapsible
 *  accordion — a naive contiguous scan is safe because scopeChoices()
 *  itself groups by resource before flattening. */
function groupScopesByResource(scopes: string[]): { resource: string; scopes: string[] }[] {
  const groups: { resource: string; scopes: string[] }[] = [];
  const byResource = new Map<string, string[]>();
  for (const scope of scopes) {
    const resource = scope.split(":")[0];
    let list = byResource.get(resource);
    if (!list) {
      list = [];
      byResource.set(resource, list);
      groups.push({ resource, scopes: list });
    }
    list.push(scope);
  }
  return groups;
}

// Derived from the SCOPES registry (see scopeChoices' own doc comment) so a
// newly registered resource/scope shows up here automatically instead of
// requiring a second hand-maintained list that can silently drift stale.
const ALL_SCOPES = scopeChoices();

type Scope = string;

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked: boolean;
  created_at: string;
  /** Decision 21: null = never expires (tokens minted before the 90-day default). */
  expires_at?: string | null;
  days_left?: number | null;
  expiring_soon?: boolean;
}

/** Decision 21 - "expires in N days" wording; the warning shows under 14 days. */
function expiryLabel(t: ApiToken): string | null {
  if (t.revoked || !t.expires_at) return null;
  const left = t.days_left ?? null;
  if (left === null) return null;
  if (left < 0) return "expired";
  if (left === 0) return "expires today";
  return `expires in ${left} day${left === 1 ? "" : "s"}`;
}

// The exact MCP client config from web/mcp/README.md ("Claude Desktop"
// section) — copied verbatim so it works unmodified in a real client. The
// placeholder token string is intentionally not a real token.
const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "nopm": {
      "command": "node",
      "args": ["/absolute/path/to/NoPM/web/mcp/server.mjs"],
      "env": {
        "NOPM_API_URL": "https://stillnotbald.com",
        "NOPM_TOKEN": "npm_your_token_here"
      }
    }
  }
}`;

type AgentTab = "pat" | "mcp" | "byok";
const AGENT_TABS: { key: AgentTab; label: string }[] = [
  { key: "pat", label: "Mint scoped PAT" },
  { key: "mcp", label: "MCP config" },
  { key: "byok", label: "BYOK assistant" },
];

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function TokensPage() {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const sessionStatus = useRequireSession();
  const uid = useId();

  // --- role gate (L-46) — API tokens are admin/manager-only server-side
  // (see requireTokenAdmin() in api/tokens/route.ts); a viewer or plain
  // "member" hitting GET /api/tokens today just gets a raw 403 rendered as
  // listError. undefined = still loading /api/me. ---
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const canManageTokens = role === "admin" || role === "manager";

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let cancelled = false;
    apiGet<{ role?: string | null } | null>("/api/me")
      .then((me) => {
        if (!cancelled) setRole(me?.role ?? null);
      })
      .catch(() => {
        if (!cancelled) setRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus]);

  // --- list state ---
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // --- mint form state ---
  const [mintName, setMintName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<Scope>>(new Set());
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  // --- connect-your-agent card (L-49) ---
  const [agentTab, setAgentTab] = useState<AgentTab>("pat");
  const [agentTokenName, setAgentTokenName] = useState("AI agent");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const loadTokens = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setTokens((await apiGet<ApiToken[] | null>("/api/tokens")) ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    // Only admin/manager can list tokens — skip the fetch entirely for
    // everyone else instead of surfacing its 403 as listError.
    if (!canManageTokens) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTokens();
  }, [canManageTokens, loadTokens]);

  const toggleScope = (scope: Scope) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  // Shared mint call — the manual scope-picker form and the "Connect your
  // agent" least-privilege preset (L-49) both go through this one path, so
  // there is exactly one mint flow, one API call, one audit row shape.
  // Returns true on success so callers know whether to reset their own form.
  const mintToken = useCallback(
    async (name: string, scopes: string[]) => {
      if (!name.trim()) {
        setMintError("Token name is required.");
        return false;
      }
      if (scopes.length === 0) {
        setMintError("Select at least one scope.");
        return false;
      }
      setMinting(true);
      setMintError(null);
      setNewToken(null);
      try {
        const created = await apiPost<{ token?: string } | null>("/api/tokens", { name: name.trim(), scopes });
        setNewToken(created?.token ?? null);
        await loadTokens();
        router.refresh();
        return true;
      } catch (e) {
        setMintError(e instanceof Error ? e.message : "Unknown error");
        return false;
      } finally {
        setMinting(false);
      }
    },
    [loadTokens, router],
  );

  const handleMint = async () => {
    const ok = await mintToken(mintName, [...selectedScopes]);
    if (ok) {
      setMintName("");
      setSelectedScopes(new Set());
    }
  };

  // Least-privilege agent preset (L-49, K4): read-only + task/risk/issue/project:write, asserted
  // against the scopes registry in scopes.test.ts — never approve/admin.
  const handleMintAgentPreset = async () => {
    await mintToken(agentTokenName, [...AGENT_PRESET_SCOPES]);
  };

  // Revoking an agent's credential is irreversible and takes effect at once, so
  // it asks first (listing what happens) and keeps the dialog open with the
  // API's message if the call fails — never a silent no-op.
  const askRevoke = (token: ApiToken) => {
    modal.open(
      <ConfirmDialog
        heading={`Revoke “${token.name}”?`}
        confirmLabel="Revoke token"
        failureFallback="Could not revoke the token."
        onConfirm={async () => {
          await apiDelete(`/api/tokens/${token.id}`);
          toast.success("Token revoked.");
          await loadTokens();
          router.refresh();
        }}
      >
        <ul className="list-disc space-y-1 pl-5">
          <li>Anything using this token stops working at once.</li>
          <li>What it did stays in the Trust Center.</li>
          <li>A revoked token can&apos;t be restored. Mint a new one.</li>
        </ul>
      </ConfirmDialog>,
      { title: "Revoke API token", size: "sm" },
    );
  };

  function onTabKeyDown(e: React.KeyboardEvent, idx: number) {
    const last = AGENT_TABS.length - 1;
    let target = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") target = idx === last ? 0 : idx + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") target = idx === 0 ? last : idx - 1;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = last;
    if (target < 0) return;
    e.preventDefault();
    setAgentTab(AGENT_TABS[target].key);
    tabRefs.current[target]?.focus();
  }

  // >=md table columns for the token list (DataList) — visually identical
  // to the hand-rolled <table> this replaced. The <md card is fully custom
  // via `renderCard` below (scope COUNT chip + Revoke in the card footer,
  // rather than every scope badge inline), so these columns never drive the
  // mobile rendering.
  const tokenColumns: DataListColumn<ApiToken>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (t) => <span className="font-medium text-ink">{t.name}</span>,
    },
    {
      key: "prefix",
      header: "Prefix",
      cell: (t) => <span className="font-mono text-ink-secondary">{t.prefix}…</span>,
    },
    {
      key: "scopes",
      header: "Scopes",
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {t.scopes.map((s) => (
            <Badge key={s} tone="neutral">
              {s}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "lastUsed",
      header: "Last used",
      cell: (t) => <span className="text-ink-secondary">{formatRelative(t.last_used_at)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) =>
        t.revoked ? (
          <Badge tone="danger">revoked</Badge>
        ) : t.expiring_soon ? (
          <Badge tone="warning">{expiryLabel(t)}</Badge>
        ) : (
          <div className="flex flex-col gap-0.5">
            <Badge tone="success">active</Badge>
            {expiryLabel(t) && <span className="text-xs text-ink-muted">{expiryLabel(t)}</span>}
          </div>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (t) =>
        !t.revoked ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger-ink hover:bg-danger/10"
            aria-label={`Revoke ${t.name}`}
            onClick={() => askRevoke(t)}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  // Client-safe auth guard — tokens has no server component wrapping it, so
  // it previously showed a broken empty state to unauthenticated visitors.
  // Render nothing until the session check resolves; useRequireSession
  // handles the redirect.
  if (sessionStatus !== "authenticated") return null;

  // Still resolving /api/me — avoid a flash of the wrong (member/viewer)
  // state before we know the real role.
  if (role === undefined) {
    return (
      <PageContainer width="narrow">
        <div className="flex items-center justify-center py-16" role="status">
          <Spinner />
        </div>
      </PageContainer>
    );
  }

  // Token management is admin/manager-only server-side (L-46 role-aware
  // empty state — the shared demo login is a VIEWER and would otherwise
  // just 403 against GET/POST /api/tokens).
  if (!canManageTokens) {
    return (
      <PageContainer width="narrow" className="space-y-6">
        <PageHeader title="API Tokens" />
        <Card>
          <EmptyState
            purpose="API tokens let an agent or CI job call NoPM's API. Only admins and managers can mint or revoke them, so every token has an accountable owner."
            canWrite={false}
          />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="narrow" className="space-y-6">
      <PageHeader
        title="API Tokens"
        action={<ExportCsvButton href="/api/export?entity=tokens" label="Export tokens (CSV)" />}
      />

      {/* One-time reveal. Takes focus and scrolls itself into view (the mint
          forms can be a long way down the page, esp. on a phone). */}
      {newToken && (
        <ShowOncePanel
          heading="Your new token"
          onDismiss={() => setNewToken(null)}
          returnFocusTo={() => document.getElementById(`${uid}-existing`)}
        >
          <CopyValue label="Token" value={newToken} subject="token" />
        </ShowOncePanel>
      )}

      {/* Connect your agent (L-49) — three paths into the governed API. */}
      <Card id="connect-agent">
        <CardHeader>
          <div>
            <CardTitle>Connect your agent</CardTitle>
            <p className="mt-0.5 text-xs text-ink-muted">
              NoPM has no built-in model. Use your own agent or MCP client.
            </p>
          </div>
        </CardHeader>
        <CardBody className="space-y-5">
          <div role="tablist" aria-label="Connect your agent" className="flex flex-wrap gap-1.5">
            {AGENT_TABS.map((tab, i) => {
              const isActive = agentTab === tab.key;
              return (
                <button
                  key={tab.key}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  id={`${uid}-tab-${tab.key}`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`${uid}-panel-${tab.key}`}
                  tabIndex={isActive ? 0 : -1}
                  type="button"
                  onClick={() => setAgentTab(tab.key)}
                  onKeyDown={(e) => onTabKeyDown(e, i)}
                  className={cn(
                    "focus-ring min-h-[44px] rounded-md border px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0",
                    isActive
                      ? "border-border-strong bg-canvas text-ink"
                      : "border-border-subtle bg-surface text-ink-secondary hover:bg-well hover:text-ink",
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {agentTab === "pat" && (
            <div
              role="tabpanel"
              id={`${uid}-panel-pat`}
              aria-labelledby={`${uid}-tab-pat`}
              className="space-y-3"
            >
              <p className="text-sm text-ink-secondary">
                Least-privilege token for an agent.
              </p>
              <Disclosure summary="More">
                <p className="text-sm text-ink-secondary">
                  It can read every register, create or edit tasks, risks, issues and projects,
                  and lock a project (never unlock). It cannot delete a risk or issue, request
                  or approve a deletion, decide a change request, approve a rebaseline, or
                  manage tokens.
                </p>
              </Disclosure>
              <div className="flex flex-wrap gap-1">
                {AGENT_PRESET_SCOPES.map((s) => (
                  <Badge key={s} tone="neutral">
                    {s}
                  </Badge>
                ))}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={agentTokenName}
                  onChange={(e) => setAgentTokenName(e.target.value)}
                  disabled={minting}
                  className="h-11 sm:h-10 sm:max-w-xs text-base sm:text-sm"
                  aria-label="Agent token name"
                />
                <Button
                  variant="primary"
                  size="md"
                  className="h-11 w-full sm:h-10 sm:w-auto"
                  onClick={handleMintAgentPreset}
                  disabled={minting || !agentTokenName.trim()}
                >
                  {minting ? (
                    <>
                      <Spinner size="sm" className="mr-2" /> Minting…
                    </>
                  ) : (
                    "Mint agent token"
                  )}
                </Button>
              </div>
              {mintError && <InlineAlert>{mintError}</InlineAlert>}
              <p className="text-xs text-ink-muted">
                Shown once. Copy it into your agent now.
              </p>
            </div>
          )}

          {agentTab === "mcp" && (
            <div
              role="tabpanel"
              id={`${uid}-panel-mcp`}
              aria-labelledby={`${uid}-tab-mcp`}
              className="space-y-3"
            >
              <p className="text-sm text-ink-secondary">
                Mint a PAT above, paste this into <code className="font-mono text-xs">.mcp.json</code>
                (or your client&apos;s config) and set <code className="font-mono text-xs">NOPM_TOKEN</code> to the token.
              </p>
              <pre className="overflow-x-auto rounded-md bg-canvas border border-border-subtle px-3 py-3 text-xs font-mono text-ink whitespace-pre">
                {MCP_CONFIG_JSON}
              </pre>
              <CopyButton value={MCP_CONFIG_JSON} subject="MCP config" label="Copy config" />
              <p className="text-xs text-ink-muted">
                Full setup: <code className="font-mono text-xs">web/mcp/README.md</code>.
              </p>
            </div>
          )}

          {agentTab === "byok" && (
            <div
              role="tabpanel"
              id={`${uid}-panel-byok`}
              aria-labelledby={`${uid}-tab-byok`}
              className="space-y-3"
            >
              <p className="text-sm text-ink-secondary">
                Open the AI assistant (the <span className="inline-flex items-center gap-1 font-medium text-ink">✦ Sparkles</span> icon
                in the top navigation), choose{" "}
                <span className="font-medium text-ink">&ldquo;Connect your own model&rdquo;</span> and
                paste your OpenAI, Anthropic or Google key.
              </p>
              <Disclosure summary="More">
                <p className="text-xs text-ink-muted">
                  NoPM ships no model or key. Your key works through a short-lived scoped token, audited like any other agent.
                </p>
              </Disclosure>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Token list */}
      <Card>
        <CardHeader>
          <CardTitle id={`${uid}-existing`} tabIndex={-1} className="focus:outline-none">
            Existing tokens
          </CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {listLoading ? (
            <div className="flex items-center justify-center py-10" role="status">
              <Spinner />
            </div>
          ) : listError ? (
            <div className="space-y-3 px-5 py-6">
              <InlineAlert>{listError}</InlineAlert>
              <Button variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={loadTokens}>
                Try again
              </Button>
            </div>
          ) : (
            <DataList<ApiToken>
              columns={tokenColumns}
              rows={tokens}
              rowKey={(t) => t.id}
              tableClassName="min-w-[640px]"
              renderCard={(tok) => {
                const isRevoked = tok.revoked;
                return (
                  <div className="flex min-h-[44px] flex-col gap-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{tok.name}</p>
                        <p className="font-mono text-xs text-ink-secondary">{tok.prefix}…</p>
                      </div>
                      {isRevoked ? (
                        <Badge tone="danger" className="shrink-0">revoked</Badge>
                      ) : tok.expiring_soon ? (
                        <Badge tone="warning" className="shrink-0">{expiryLabel(tok)}</Badge>
                      ) : (
                        <Badge tone="success" className="shrink-0">active</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">
                        {tok.scopes.length} scope{tok.scopes.length !== 1 ? "s" : ""}
                      </Badge>
                      <span className="text-xs text-ink-muted">
                        Last used {formatRelative(tok.last_used_at)}
                      </span>
                    </div>
                    {!isRevoked && (
                      <div className="-mx-4 -mb-3 mt-1 border-t border-border-subtle px-4 pt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-11 w-full text-danger-ink hover:bg-danger/10"
                          aria-label={`Revoke ${tok.name}`}
                          onClick={() => askRevoke(tok)}
                        >
                          Revoke
                        </Button>
                      </div>
                    )}
                  </div>
                );
              }}
              empty={
                <EmptyState
                  purpose="No tokens yet. A scoped token lets an agent or script call the API. Every action is audited under the token."
                  className="py-10"
                />
              }
            />
          )}
        </CardBody>
      </Card>

      {/* Mint panel */}
      <Card>
        <CardHeader>
          <CardTitle>Mint a token</CardTitle>
        </CardHeader>
        <CardBody>
          <form
            className="space-y-5"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void handleMint();
            }}
          >
            <Field id={`${uid}-mint-name`} label="Token name">
              {(a11y) => (
                <Input
                  {...a11y}
                  placeholder="e.g. ci-risk-scanner"
                  value={mintName}
                  onChange={(e) => setMintName(e.target.value)}
                  disabled={minting}
                  autoComplete="off"
                  className="h-11 sm:h-10 text-base sm:text-sm"
                />
              )}
            </Field>

            <fieldset className="min-w-0 space-y-2">
              <legend className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                Scopes
              </legend>

              {/* <md (phone): one-handed collapsible groups by resource, so the
                  full ~30-scope list isn't one long scroll of checkboxes. */}
              <div className="space-y-2 md:hidden">
                {groupScopesByResource(ALL_SCOPES).map((g) => {
                  const selectedCount = g.scopes.filter((s) => selectedScopes.has(s)).length;
                  return (
                    <details key={g.resource} className="group rounded-md border border-border-subtle bg-surface">
                      <summary className="focus-ring flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden">
                        <span className="text-sm font-medium text-ink capitalize">
                          {g.resource.replace(/_/g, " ")}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {selectedCount > 0 && (
                            <span className="rounded-full bg-accent px-1.5 py-0.5 font-mono text-2xs font-medium text-accent-ink">
                              <span className="sr-only">{selectedCount} selected</span>
                              <span aria-hidden="true">{selectedCount}</span>
                            </span>
                          )}
                          <ChevronDown
                            size={16}
                            aria-hidden="true"
                            className="text-ink-muted transition-transform group-open:rotate-180"
                          />
                        </span>
                      </summary>
                      <div className="space-y-1 border-t border-border-subtle px-3 py-2">
                        {g.scopes.map((scope) => (
                          <label
                            key={scope}
                            className="flex min-h-[44px] items-center gap-2 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={selectedScopes.has(scope)}
                              onChange={() => toggleScope(scope)}
                              disabled={minting}
                              className="h-4 w-4 rounded border-border-subtle accent-accent cursor-pointer shrink-0"
                            />
                            <span className="text-sm text-ink font-mono">{scope}</span>
                          </label>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>

              {/* >=md (desktop/tablet): unchanged flat grid. */}
              <div className="hidden md:grid md:grid-cols-2 md:gap-x-6 md:gap-y-2 lg:grid-cols-3">
                {ALL_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(scope)}
                      onChange={() => toggleScope(scope)}
                      disabled={minting}
                      className="h-4 w-4 rounded border-border-subtle accent-accent cursor-pointer shrink-0"
                    />
                    <span className="text-sm text-ink font-mono">{scope}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* Whoever mints a token should learn the consequence at mint time. */}
            <FourEyesNote variant="quiet" />

            {mintError && <InlineAlert>{mintError}</InlineAlert>}

            <Button
              type="submit"
              variant="primary"
              size="md"
              className="h-11 w-full sm:h-10 sm:w-auto"
              disabled={minting || !mintName.trim() || selectedScopes.size === 0}
            >
              {minting ? (
                <>
                  <Spinner size="sm" className="mr-2" /> Minting…
                </>
              ) : (
                "Mint token"
              )}
            </Button>
          </form>
        </CardBody>
      </Card>
    </PageContainer>
  );
}
