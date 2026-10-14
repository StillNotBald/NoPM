"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { apiGet, apiPost } from "@/lib/api-client";

type MemberRole = "viewer" | "member" | "manager" | "admin";
const ROLE_RANK: Record<MemberRole, number> = { viewer: 0, member: 1, manager: 2, admin: 3 };
const ALL_ROLES: MemberRole[] = ["viewer", "member", "manager", "admin"];

type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

interface Invite {
  id: string;
  email: string;
  role: MemberRole;
  name: string | null;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
}

const STATUS_TONE: Record<InviteStatus, "success" | "neutral" | "danger" | "warning"> = {
  pending: "warning",
  accepted: "success",
  revoked: "danger",
  expired: "neutral",
};

/**
 * "Invite a colleague" (L-47/L-48). Admin/manager-only, mirroring the
 * tokens page's role gate (D5). A creator can only offer roles up to their
 * own rank — the client-side role picker is filtered to match, so the D5
 * 422 rarely fires; the API enforces the cap regardless.
 */
export function InvitesCard() {
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const canManage = role === "admin" || role === "manager";

  useEffect(() => {
    let cancelled = false;
    apiGet<{ role: string | null }>("/api/me")
      .then((data) => {
        if (!cancelled) setRole(data?.role ?? null);
      })
      .catch(() => {
        if (!cancelled) setRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [invites, setInvites] = useState<Invite[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [newInviteUrl, setNewInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await apiGet<Invite[]>("/api/invites");
      setInvites(data ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load invites");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadInvites();
  }, [canManage, loadInvites]);

  // Client-side mirror of D5's role-escalation cap — only offer roles the
  // caller is actually allowed to mint (the API enforces this regardless).
  const creatorRank = role && role in ROLE_RANK ? ROLE_RANK[role as MemberRole] : -1;
  const availableRoles = ALL_ROLES.filter((r) => ROLE_RANK[r] <= creatorRank);

  const handleInvite = async () => {
    if (!email.trim()) {
      setMintError("Email is required.");
      return;
    }
    setMinting(true);
    setMintError(null);
    setNewInviteUrl(null);
    try {
      const data = await apiPost<{ invite_url: string }>("/api/invites", {
        email: email.trim(),
        role: inviteRole,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setNewInviteUrl(data.invite_url);
      setEmail("");
      setName("");
      await loadInvites();
    } catch (e) {
      setMintError(e instanceof Error ? e.message : "Failed to create invite");
    } finally {
      setMinting(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevoking(id);
    try {
      await apiPost(`/api/invites/${id}/revoke`);
      await loadInvites();
    } catch {
      // surface via reload — invites list stays authoritative
      await loadInvites();
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = async () => {
    if (!newInviteUrl) return;
    await navigator.clipboard.writeText(newInviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (role === undefined) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invite a colleague</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex items-center justify-center py-6">
            <Spinner size="sm" />
          </div>
        </CardBody>
      </Card>
    );
  }

  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invite a colleague</CardTitle>
        </CardHeader>
        <CardBody>
          <EmptyState
            purpose="Link invites are audited and revocable — minting one is restricted to admins and managers so every new member ties back to an accountable inviter."
            canWrite={false}
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a colleague</CardTitle>
      </CardHeader>
      <CardBody className="space-y-5">
        <p className="text-sm text-ink-secondary">
          Send a link — no email delivery required. Accepting it creates their login AND their
          resource-member record together, so assignment/capacity/cost work immediately.
        </p>

        {newInviteUrl && (
          <div className="rounded-lg border border-border-subtle bg-sunken p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-ink">Invite link</p>
              <Badge tone="warning">Shown once — copy it now.</Badge>
            </div>
            <code className="block break-all rounded-md bg-canvas border border-border-subtle px-3 py-2 text-sm font-mono text-ink">
              {newInviteUrl}
            </code>
            <Button variant="secondary" size="sm" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy link"}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <Input
            type="email"
            placeholder="colleague@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={minting}
            aria-label="Invite email"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as MemberRole)}
            disabled={minting}
            aria-label="Invite role"
            className={cn(
              "h-11 sm:h-10 rounded-md border border-border-subtle bg-canvas px-2.5 text-base sm:text-sm text-ink",
              "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
            )}
          >
            {availableRoles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <Input
          type="text"
          placeholder="Full name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={minting}
          aria-label="Invite name"
        />

        {mintError && (
          <p className="rounded-md bg-danger/15 px-3 py-2 text-sm text-danger">{mintError}</p>
        )}

        <Button variant="primary" size="md" onClick={handleInvite} disabled={minting || !email.trim()}>
          {minting ? (
            <>
              <Spinner size="sm" className="mr-2" /> Creating…
            </>
          ) : (
            "Create invite"
          )}
        </Button>

        <div className="pt-2">
          {listLoading ? (
            <div className="flex items-center justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : listError ? (
            <p className="text-sm text-danger">{listError}</p>
          ) : invites.length === 0 ? (
            <p className="text-sm text-ink-muted">No invites yet.</p>
          ) : (
            <div className="relative overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-xs text-ink-muted uppercase tracking-wide">
                    <th className="px-5 py-3 font-medium">Email</th>
                    <th className="px-5 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv, i) => (
                    <tr
                      key={inv.id}
                      className={cn(
                        "border-b border-border-subtle last:border-0",
                        i % 2 === 1 && "bg-sunken/40",
                      )}
                    >
                      <td className="px-5 py-3 text-ink">
                        {inv.email}
                        {inv.name && <span className="text-ink-muted"> · {inv.name}</span>}
                      </td>
                      <td className="px-5 py-3 capitalize text-ink-secondary">{inv.role}</td>
                      <td className="px-5 py-3">
                        <Badge tone={STATUS_TONE[inv.status]}>{inv.status}</Badge>
                      </td>
                      <td className="px-5 py-3">
                        {inv.status === "pending" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:bg-danger/10"
                            disabled={revoking === inv.id}
                            onClick={() => handleRevoke(inv.id)}
                          >
                            {revoking === inv.id ? <Spinner size="sm" /> : "Revoke"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
