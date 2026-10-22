"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { fetchNudgeSettings, saveNudgeSettings, sendWeeklyReportNow, type NudgeSettingsView } from "./api";
import { useApiResource } from "./hooks";
import { errorText } from "./model";
import { CheckRow, Disclosure, Field, LoadingRow, Select } from "./shared";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Stale-item nudges and the weekly status report (R-141 / R-142). Admins edit;
 * everyone reads. Admins and managers can also send the weekly report now
 * (in-app notification plus the email demo-preview; nothing is emailed).
 */
export function NudgeSettingsCard({ role }: { role: string | null | undefined }) {
  const toast = useToast();
  const { state, reload } = useApiResource(fetchNudgeSettings);
  const [draft, setDraft] = useState<NudgeSettingsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  if (state.status === "loading") {
    return (
      <Card>
        <CardBody>
          <LoadingRow label="Loading nudge settings" />
        </CardBody>
      </Card>
    );
  }
  if (state.status !== "ready") return null;

  const isAdmin = role === "admin";
  const canSend = role === "admin" || role === "manager";
  const saved = state.data;
  const value = draft ?? saved;
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const staleInvalid = !Number.isInteger(value.staleDays) || value.staleDays < 1 || value.staleDays > 365;
  const set = (patch: Partial<NudgeSettingsView>) => setDraft({ ...value, ...patch });

  async function save() {
    setSaving(true);
    try {
      await saveNudgeSettings(value);
      toast.success("Nudge settings saved.");
      setDraft(null);
      reload();
    } catch (e) {
      toast.error(errorText(e, "Could not save the nudge settings."));
    } finally {
      setSaving(false);
    }
  }

  async function sendNow() {
    setSending(true);
    try {
      const r = await sendWeeklyReportNow();
      toast.success(`Weekly report sent to ${r.recipients} ${r.recipients === 1 ? "person" : "people"}.`);
    } catch (e) {
      toast.error(errorText(e, "Could not send the weekly report."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nudges and weekly report</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-secondary">Owners get a nudge when an open item has not changed for the days below.</p>
        <Disclosure summary="More">
          <p>
            An open task, risk or issue is stale when its last recorded change is that many days old. Nudges and the weekly report
            use this rule; the board card flag counts days in the current status. The owner gets at most one notification a week
            per item. Admins and managers also get a weekly status report. Nothing is emailed; the Email previews page shows what the
            email would look like.
          </p>
        </Disclosure>

        <Field
          id="stale-days"
          label="Stale after (days)"
          hint="1 to 365. Default 14."
          error={staleInvalid ? "Use a whole number from 1 to 365." : undefined}
        >
          {(a11y) => (
            <Input
              {...a11y}
              type="number"
              inputMode="numeric"
              min={1}
              max={365}
              value={Number.isNaN(value.staleDays) ? "" : value.staleDays}
              disabled={!isAdmin || saving}
              onChange={(e) => set({ staleDays: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
              className="w-full sm:w-32"
            />
          )}
        </Field>

        <CheckRow
          checked={value.nudgesEnabled}
          onChange={(v) => set({ nudgesEnabled: v })}
          title="Send stale-item nudges"
          description="A daily check; owners are notified in the app."
          disabled={!isAdmin || saving}
        />
        <CheckRow
          checked={value.weeklyReportEnabled}
          onChange={(v) => set({ weeklyReportEnabled: v })}
          title="Send the weekly status report"
          description="To admins and managers, on the day below (workspace time zone)."
          disabled={!isAdmin || saving}
        />

        <Field id="weekly-report-day" label="Weekly report day">
          {(a11y) => (
            <Select
              {...a11y}
              value={value.weeklyReportDay}
              disabled={!isAdmin || saving || !value.weeklyReportEnabled}
              onChange={(e) => set({ weeklyReportDay: Number(e.target.value) })}
              className="w-full sm:w-48"
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          {isAdmin ? (
            <Button size="sm" disabled={saving || !dirty || staleInvalid} onClick={save}>
              {saving ? "Saving..." : "Save"}
            </Button>
          ) : (
            <p className="text-xs text-ink-muted">Only workspace admins can change these settings.</p>
          )}
          {canSend && (
            <Button size="sm" variant="secondary" disabled={sending || dirty} onClick={sendNow}>
              {sending ? "Sending..." : "Send weekly report now"}
            </Button>
          )}
        </div>
        {canSend && dirty && <p className="text-xs text-ink-muted">Save before sending.</p>}
      </CardBody>
    </Card>
  );
}
