"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ShowOncePanel } from "@/components/governance/show-once-panel";
import { ConfirmDialog, CopyButton, InlineAlert, Select } from "@/components/integrations/shared";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api-client";

type Role = "viewer" | "member" | "manager" | "admin";
const ROLES: Role[] = ["viewer", "member", "manager", "admin"];

export interface Member {
  id: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  status: "active" | "removed";
  mfa_enabled: boolean;
}

/**
 * People & roles. Admins change roles, remove people and reset two-step;
 * managers see the list (they invite from Settings, up to manager). The API
 * enforces every rule (last admin, who may do what); this only hides what the
 * caller cannot do.
 */
export function PeoplePanel() {
  const toast = useToast();
  const router = useRouter();
  const modal = useModal();
  const [me, setMe] = useState<{ id: string; role: string | null } | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<{ name: string; codes: string[] } | null>(null);

  const isAdmin = me?.role === "admin";

  const load = useCallback(async () => {
    try {
      setMembers(await apiGet<Member[]>("/api/members"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load people.");
    }
  }, []);

  useEffect(() => {
    apiGet<{ id: string; role: string | null }>("/api/me")
      .then((d) => setMe({ id: d.id, role: d.role }))
      .catch(() => setMe({ id: "", role: null }));
    apiGet<Member[]>("/api/members")
      .then((rows) => setMembers(rows))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load people."));
  }, []);

  const label = (m: Member) => m.display_name || m.email || m.id;

  async function changeRole(m: Member, role: Role) {
    try {
      await apiPatch(`/api/members/${m.id}`, { role });
      toast.success(`${label(m)} is now ${role}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the role.");
    }
    await load();
  }

  const askRemove = (m: Member) => {
    const self = m.id === me?.id;
    modal.open(
      <ConfirmDialog
        heading={self ? "Leave this workspace?" : `Remove ${label(m)}?`}
        confirmLabel={self ? "Leave" : "Remove"}
        failureFallback="Could not remove the person."
        onConfirm={async () => {
          await apiDelete(`/api/members/${m.id}`);
          toast.success(self ? "You left the workspace." : `${label(m)} was removed.`);
          if (self) router.push("/login");
          else await load();
        }}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-secondary">
          <li>They can no longer sign in.</li>
          <li>Their API tokens stop working and the invites they sent are cancelled.</li>
          <li>Their history stays in the audit trail. Calendar feeds they made keep working until revoked.</li>
        </ul>
      </ConfirmDialog>,
      { title: self ? "Leave workspace" : "Remove person", size: "sm" },
    );
  };

  const askReset = (m: Member) => {
    modal.open(
      <ConfirmDialog
        heading={`Reset two-step for ${label(m)}?`}
        confirmLabel="Reset two-step"
        failureFallback="Could not reset two-step."
        onConfirm={async () => {
          const r = await apiPost<{ backup_codes: string[] }>(`/api/members/${m.id}/mfa-reset`);
          setCodes({ name: label(m), codes: r.backup_codes });
          toast.success("Two-step reset. Give them a backup code.");
          await load();
        }}
      >
        <p className="text-sm text-ink-secondary">
          Their authenticator is cleared and you get one-time backup codes, shown once. They are told in the app. They
          sign in with one code, then set up their authenticator again.
        </p>
      </ConfirmDialog>,
      { title: "Reset two-step", size: "sm" },
    );
  };

  async function restore(m: Member) {
    try {
      await apiPost(`/api/members/${m.id}/restore`, {});
      toast.success(`${label(m)} is back.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore the person.");
    }
    await load();
  }

  if (!members && !error) {
    return (
      <div className="flex items-center justify-center py-16" role="status">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      {codes ? (
        <ShowOncePanel
          heading={`Backup codes for ${codes.name}`}
          notice="Shown once. Each code works one time. Hand one over securely."
          onDismiss={() => setCodes(null)}
        >
          <ul className="space-y-1 font-mono text-xs">
            {codes.codes.map((c) => (
              <li key={c} className="flex items-center gap-2">
                <span className="break-all">{c}</span>
                <CopyButton value={c} subject="backup code" />
              </li>
            ))}
          </ul>
        </ShowOncePanel>
      ) : null}
      <Card>
        <CardBody className="p-0">
          <ul className="divide-y divide-line">
            {(members ?? []).map((m) => {
              const self = m.id === me?.id;
              const removed = m.status === "removed";
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {label(m)} {self ? <span className="text-ink-muted">(you)</span> : null}
                    </p>
                    {m.email && m.display_name ? <p className="truncate text-xs text-ink-muted">{m.email}</p> : null}
                  </div>
                  {removed ? <Badge tone="danger">removed</Badge> : null}
                  {!removed && m.mfa_enabled ? <Badge tone="success">two-step</Badge> : null}
                  {isAdmin && !removed ? (
                    <Select
                      aria-label={`Role for ${label(m)}`}
                      value={m.role}
                      onChange={(e) => void changeRole(m, e.target.value as Role)}
                      className="w-32"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Badge tone="neutral">{m.role}</Badge>
                  )}
                  {isAdmin && !removed && !self ? (
                    <Button variant="secondary" size="sm" onClick={() => askReset(m)}>
                      Reset two-step
                    </Button>
                  ) : null}
                  {isAdmin && removed ? (
                    <Button variant="secondary" size="sm" onClick={() => void restore(m)}>
                      Restore
                    </Button>
                  ) : null}
                  {!removed && (isAdmin || self) ? (
                    <Button variant="danger" size="sm" onClick={() => askRemove(m)}>
                      {self ? "Leave" : "Remove"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
