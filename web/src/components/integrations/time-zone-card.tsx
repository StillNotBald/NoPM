"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { fetchTimeZone, saveTimeZone } from "./api";
import { useApiResource } from "./hooks";
import { errorText } from "./model";
import { Field, LoadingRow, Select } from "./shared";

const ZONES = [
  "Asia/Kuala_Lumpur",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Bangkok",
  "Asia/Manila",
  "Asia/Taipei",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];

/**
 * Workspace time zone (admin edits, everyone reads). It sets the weekday the
 * weekly digest goes out on and what "today" means in server-side defaults.
 * The default is Asia/Kuala_Lumpur.
 */
export function TimeZoneCard({ isAdmin }: { isAdmin: boolean | null }) {
  const toast = useToast();
  const { state, reload } = useApiResource(fetchTimeZone);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (state.status === "loading") {
    return (
      <Card>
        <CardBody>
          <LoadingRow label="Loading time zone" />
        </CardBody>
      </Card>
    );
  }
  if (state.status !== "ready") return null;

  const saved = state.data.timeZone;
  const value = draft ?? saved;
  const options = ZONES.includes(saved) ? ZONES : [saved, ...ZONES];

  async function save() {
    setSaving(true);
    try {
      await saveTimeZone(value);
      toast.success("Time zone saved.");
      setDraft(null);
      reload();
    } catch (e) {
      toast.error(errorText(e, "Could not save the time zone."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace time zone</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Sets which day &ldquo;today&rdquo; is and the weekday the weekly digest goes out on. Sending the digest by
          hand never counts as the weekly one.
        </p>
        <Field id="workspace-time-zone" label="Time zone">
          {(a11y) => (
            <Select {...a11y} value={value} disabled={!isAdmin || saving} onChange={(e) => setDraft(e.target.value)}>
              {options.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {isAdmin ? (
          <Button size="sm" disabled={saving || value === saved} onClick={save}>
            {saving ? "Saving..." : "Save time zone"}
          </Button>
        ) : (
          <p className="text-xs text-ink-muted">Only workspace admins can change this.</p>
        )}
      </CardBody>
    </Card>
  );
}
