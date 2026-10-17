"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { cn } from "@/lib/cn";
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
  const sessionStatus = useRequireSession();

  // --- role gate (L-46) — API tokens are admin/manager-only server-side
  // (see requireTokenAdmin() in api/tokens/route.ts); a viewer or plain
  // "member" hitting GET /api/tokens today just gets a raw 403 rendered as
  // listError. undefined = still loading /api/me. ---
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const canManageTokens = role === "admin" || role === "manager";

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    let cancelled = false;
    fetch("/api/me")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
         
        setRole(json?.data?.role ?? null);
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

  // --- revoke state ---
  const [revoking, setRevoking] = useState<string | null>(null);

  // --- mint form state ---
  const [mintName, setMintName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<Scope>>(new Set());
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // --- connect-your-agent card (L-49) ---
  const [agentTab, setAgentTab] = useState<AgentTab>("pat");
  const [agentTokenName, setAgentTokenName] = useState("AI agent");
  const [mcpCopied, setMcpCopied] = useState(false);

  const loadTokens = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/tokens");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load tokens");
      setTokens(json.data ?? []);
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
        const res = await fetch("/api/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), scopes }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to create token");
        setNewToken(json.data?.token ?? null);
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

  // Least-privilege agent preset (L-49): read-only + task:write, asserted
  // against the scopes registry in scopes.test.ts — never approve/admin.
  const handleMintAgentPreset = async () => {
    await mintToken(agentTokenName, [...AGENT_PRESET_SCOPES]);
  };

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to revoke token");
      await loadTokens();
      router.refresh();
    } catch {
      // surface inline — for now, just reload
      await loadTokens();
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = async () => {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
      cell: (t) => (t.revoked ? <Badge tone="danger">revoked</Badge> : <Badge tone="success">active</Badge>),
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
            disabled={revoking === t.id}
            onClick={() => handleRevoke(t.id)}
          >
            {revoking === t.id ? <Spinner size="sm" /> : "Revoke"}
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
      <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="mx-auto flex max-w-4xl items-center justify-center py-16">
          <Spinner />
        </div>
      </div>
    );
  }

  // Token management is admin/manager-only server-side (L-46 role-aware
  // empty state — the shared demo login is a VIEWER and would otherwise
  // just 403 against GET/POST /api/tokens).
  if (!canManageTokens) {
    return (
      <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-8">
          <PageHeader title="API Tokens" />
          <Card>
            <EmptyState
              purpose="API tokens let an external agent or CI job call NoPM's governed API. Minting and revoking tokens is restricted to admins and managers so the audit trail always ties a token back to an accountable owner."
              canWrite={false}
            />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
      <PageHeader title="API Tokens" />

      {/* Active token one-time reveal */}
      {newToken && (
        <div className="rounded-lg border border-border-subtle bg-sunken p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-ink">Your new token</p>
            <Badge tone="warning">Shown once — copy it now.</Badge>
          </div>
          <code className="block w-full break-all rounded-md bg-canvas border border-border-subtle px-3 py-2 text-sm font-mono text-ink">
            {newToken}
          </code>
          <Button variant="secondary" size="sm" className="h-11 w-full sm:h-9 sm:w-auto" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy token"}
          </Button>
        </div>
      )}

      {/* Connect your agent (L-49) — three paths into the governed API. */}
      <Card id="connect-agent">
        <CardHeader>
          <div>
            <CardTitle>Connect your agent</CardTitle>
            <p className="mt-0.5 text-xs text-ink-muted">
              NoPM bundles no LLM — point your own agent, MCP client, or model at it.
            </p>
          </div>
        </CardHeader>
        <CardBody className="space-y-5">
          <div role="tablist" aria-label="Connect your agent" className="flex flex-wrap gap-1.5">
            {AGENT_TABS.map((tab) => {
              const isActive = agentTab === tab.key;
              return (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  type="button"
                  onClick={() => setAgentTab(tab.key)}
                  className={cn(
                    "min-h-[44px] rounded-md border px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-0",
                    isActive
                      ? "border-border-strong bg-canvas text-ink shadow-sm"
                      : "border-border-subtle bg-surface text-ink-secondary hover:bg-sunken hover:text-ink",
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {agentTab === "pat" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-secondary">
                Mint a token pre-scoped to least privilege: it can read every
                register and edit/move tasks, but it can never request or
                approve a deletion, approve a rebaseline, or manage other
                tokens.
              </p>
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
              {mintError && (
                <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger-ink">{mintError}</p>
              )}
              <p className="text-xs text-ink-muted">
                Shown once — copy it into your agent&apos;s environment right away.
              </p>
            </div>
          )}

          {agentTab === "mcp" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-secondary">
                NoPM ships a native MCP server (<code className="font-mono text-xs">web/mcp/server.mjs</code>) —
                any MCP client can drive it once you mint a PAT above. Paste
                this into <code className="font-mono text-xs">.mcp.json</code> (or your client&apos;s
                equivalent config) and set <code className="font-mono text-xs">NOPM_TOKEN</code> to the token
                you just minted.
              </p>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md bg-canvas border border-border-subtle px-3 py-3 text-xs font-mono text-ink whitespace-pre">
                  {MCP_CONFIG_JSON}
                </pre>
                <Button
                  variant="secondary"
                  size="sm"
                  className="absolute right-2 top-2"
                  onClick={async () => {
                    await navigator.clipboard.writeText(MCP_CONFIG_JSON);
                    setMcpCopied(true);
                    setTimeout(() => setMcpCopied(false), 2000);
                  }}
                >
                  {mcpCopied ? "Copied!" : "Copy config"}
                </Button>
              </div>
              <p className="text-xs text-ink-muted">
                Full setup + governance guarantees: <code className="font-mono text-xs">web/mcp/README.md</code>.
              </p>
            </div>
          )}

          {agentTab === "byok" && (
            <div className="space-y-3">
              <p className="text-sm text-ink-secondary">
                Prefer chatting instead of scripting? Open the AI assistant
                (the <span className="inline-flex items-center gap-1 font-medium text-ink">✦ Sparkles</span> icon
                in the top navigation) and choose{" "}
                <span className="font-medium text-ink">&ldquo;Connect your own model&rdquo;</span> to
                paste your own OpenAI, Anthropic, or Google API key.
              </p>
              <p className="text-xs text-ink-muted">
                NoPM still ships no model and no key — your key drives NoPM&apos;s
                own governed API through an ephemeral scoped token, audited
                exactly like any other agent.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Token list */}
      <Card>
        <CardHeader>
          <CardTitle>Existing tokens</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {listLoading ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : listError ? (
            <p className="px-5 py-6 text-sm text-danger-ink">{listError}</p>
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
                          disabled={revoking === tok.id}
                          onClick={() => handleRevoke(tok.id)}
                        >
                          {revoking === tok.id ? <Spinner size="sm" /> : "Revoke"}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              }}
              empty={
                <EmptyState
                  purpose="No tokens yet. A scoped token lets an agent or script call the NoPM API on this workspace's behalf — every action it takes is audited under the token as the actor."
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
        <CardBody className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-secondary uppercase tracking-wide">
              Token name
            </label>
            <Input
              placeholder="e.g. ci-risk-scanner"
              value={mintName}
              onChange={(e) => setMintName(e.target.value)}
              disabled={minting}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-ink-secondary uppercase tracking-wide">
              Scopes
            </p>

            {/* <md (phone): one-handed collapsible groups by resource, so the
                full ~30-scope list isn't one long scroll of checkboxes. */}
            <div className="space-y-2 md:hidden">
              {groupScopesByResource(ALL_SCOPES).map((g) => {
                const selectedCount = g.scopes.filter((s) => selectedScopes.has(s)).length;
                return (
                  <details key={g.resource} className="group rounded-md border border-border-subtle bg-surface">
                    <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden">
                      <span className="text-sm font-medium text-ink capitalize">
                        {g.resource.replace(/_/g, " ")}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {selectedCount > 0 && (
                          <span className="rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
                            {selectedCount}
                          </span>
                        )}
                        <ChevronDown size={16} className="text-ink-muted transition-transform group-open:rotate-180" />
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
                <label
                  key={scope}
                  className="flex items-center gap-2 cursor-pointer group"
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                    disabled={minting}
                    className="h-4 w-4 rounded border-border-subtle accent-accent cursor-pointer shrink-0"
                  />
                  <span className="text-sm text-ink font-mono group-hover:text-accent transition-colors">
                    {scope}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {mintError && (
            <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger-ink">{mintError}</p>
          )}

          <Button
            variant="primary"
            size="md"
            onClick={handleMint}
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
        </CardBody>
      </Card>
      </div>
    </div>
  );
}
