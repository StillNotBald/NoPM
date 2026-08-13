"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { useRequireSession } from "@/lib/auth/use-require-session";

const ALL_SCOPES = [
  "project:*",
  "task:read",
  "task:write",
  "task:delete:request",
  "task:delete:approve",
  "risk:*",
  "issue:*",
  "clash:*",
  "resource:*",
  "budget:*",
  "time:*",
  "audit:read",
] as const;

type Scope = (typeof ALL_SCOPES)[number];

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTokens();
  }, [loadTokens]);

  const toggleScope = (scope: Scope) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const handleMint = async () => {
    if (!mintName.trim()) {
      setMintError("Token name is required.");
      return;
    }
    if (selectedScopes.size === 0) {
      setMintError("Select at least one scope.");
      return;
    }
    setMinting(true);
    setMintError(null);
    setNewToken(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: mintName.trim(), scopes: [...selectedScopes] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to create token");
      setNewToken(json.data?.token ?? null);
      setMintName("");
      setSelectedScopes(new Set());
      await loadTokens();
      router.refresh();
    } catch (e) {
      setMintError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setMinting(false);
    }
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

  // Client-safe auth guard — tokens has no server component wrapping it, so
  // it previously showed a broken empty state to unauthenticated visitors.
  // Render nothing until the session check resolves; useRequireSession
  // handles the redirect.
  if (sessionStatus !== "authenticated") return null;

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
          <code className="block break-all rounded-md bg-canvas border border-border-subtle px-3 py-2 text-sm font-mono text-ink">
            {newToken}
          </code>
          <Button variant="secondary" size="sm" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy token"}
          </Button>
        </div>
      )}

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
            <p className="px-5 py-6 text-sm text-danger">{listError}</p>
          ) : tokens.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">No tokens yet. Mint one below.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-xs text-ink-muted uppercase tracking-wide">
                    <th className="px-5 py-3 font-medium">Name</th>
                    <th className="px-5 py-3 font-medium">Prefix</th>
                    <th className="px-5 py-3 font-medium">Scopes</th>
                    <th className="px-5 py-3 font-medium">Last used</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((tok, i) => {
                    const isRevoked = !!tok.revoked_at;
                    return (
                      <tr
                        key={tok.id}
                        className={cn(
                          "border-b border-border-subtle last:border-0",
                          i % 2 === 1 && "bg-sunken/40",
                        )}
                      >
                        <td className="px-5 py-3 font-medium text-ink">{tok.name}</td>
                        <td className="px-5 py-3 font-mono text-ink-secondary">{tok.prefix}…</td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {tok.scopes.map((s) => (
                              <Badge key={s} tone="neutral">
                                {s}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-ink-secondary">
                          {formatRelative(tok.last_used_at)}
                        </td>
                        <td className="px-5 py-3">
                          {isRevoked ? (
                            <Badge tone="danger">revoked</Badge>
                          ) : (
                            <Badge tone="success">active</Badge>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          {!isRevoked && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:bg-danger/10"
                              disabled={revoking === tok.id}
                              onClick={() => handleRevoke(tok.id)}
                            >
                              {revoking === tok.id ? <Spinner size="sm" /> : "Revoke"}
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
            <div className="grid grid-cols-1 gap-y-3 sm:grid-cols-2 sm:gap-x-6 sm:gap-y-2 lg:grid-cols-3">
              {ALL_SCOPES.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 cursor-pointer group min-h-[44px] sm:min-h-0"
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
            <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{mintError}</p>
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
