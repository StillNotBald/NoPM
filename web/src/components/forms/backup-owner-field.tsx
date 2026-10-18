"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { Field, SelectInput } from "@/components/forms/project-form";
import { backupPayload, type BackupEntity } from "@/lib/handover/backup-form";

interface ResourceMember {
  id: string;
  name: string;
  role_title?: string | null;
  profile_id?: string | null;
}

/**
 * State for a form's "Backup owner" picker (M6).
 *
 * Why it fetches the record itself on edit: the pages that open these forms select
 * their own column lists, so the record in hand may not carry the backup. Trusting
 * that and sending `null` would silently clear a backup on every unrelated edit.
 * The hook loads the stored value and the payload carries the field only when
 * the person changed it (see `backupPayload`).
 *
 * Projects, risks and issues are owned by a login, so their options are the
 * resource members who have a linked login (value = the login id). Tasks are
 * assigned to a resource member, so their options are every resource member.
 */
export function useBackupOwner(entity: BackupEntity, recordId: string | undefined, initial?: string | null) {
  const [value, setValueState] = useState<string>(initial ?? "");
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(Boolean(recordId) && initial === undefined);
  const [members, setMembers] = useState<ResourceMember[]>([]);

  useEffect(() => {
    let live = true;
    apiGet<ResourceMember[]>("/api/resources?limit=100")
      .then((list) => live && setMembers(Array.isArray(list) ? list : []))
      .catch(() => {
        /* non-critical: the picker just stays empty */
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!recordId || initial !== undefined) return;
    let live = true;
    apiGet<Record<string, string | null>>(`/api/${entity}/${recordId}`)
      .then((row) => {
        if (!live) return;
        const field = entity === "tasks" ? "backup_assignee_id" : "backup_owner_id";
        setValueState((cur) => (cur === "" ? (row?.[field] ?? "") : cur));
      })
      .catch(() => {
        /* the picker shows "No backup"; the payload omits the field unless it is changed */
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [entity, recordId, initial]);

  const options =
    entity === "tasks"
      ? members.map((m) => ({ value: m.id, label: m.name + (m.role_title ? ` (${m.role_title})` : "") }))
      : members.filter((m) => m.profile_id).map((m) => ({ value: m.profile_id as string, label: m.name }));

  return {
    value,
    touched,
    loading,
    options,
    setValue: (v: string) => {
      setTouched(true);
      setValueState(v);
    },
    /** The fields to spread into the request body. */
    payload: (editing: boolean) => backupPayload(entity, value, touched, editing),
  };
}

/** The "Backup owner" picker. Pair with `useBackupOwner`. */
export function BackupOwnerField({
  state,
  label = "Backup owner",
  error,
}: {
  state: ReturnType<typeof useBackupOwner>;
  label?: string;
  error?: string;
}) {
  return (
    <Field
      label={label}
      error={error}
      hint="Who picks this up if the owner is away. Shows on the Handover page when empty."
    >
      <SelectInput
        value={state.value}
        disabled={state.loading}
        onChange={(e) => state.setValue(e.target.value)}
      >
        <option value="">— No backup —</option>
        {state.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </SelectInput>
    </Field>
  );
}
