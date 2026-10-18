"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  MAX_RETRO_HOURS,
  MAX_SCHEDULE_THRESHOLD_DAYS,
  MAX_TURNAROUND_HOURS,
  TIERS,
  type ApprovalPolicy,
  type Tier,
  type TierApproverRole,
} from "@/lib/governance/tiers";
import { fetchApprovalPolicy, saveApprovalPolicy } from "./api";
import { useApiResource } from "./hooks";
import { errorText } from "./model";
import { CheckRow, Field, InlineAlert, LoadingRow, Select } from "./shared";

const TIER_COPY: Record<Tier, { name: string; help: string }> = {
  routine: { name: "Routine", help: "No cost and no schedule impact." },
  normal: { name: "Normal", help: "The default for a change request or rebaseline." },
  high_risk: { name: "High risk", help: "Large cost, or deleting a whole project." },
  emergency: { name: "Emergency", help: "Ships now. This role gives the approval afterwards." },
  strategic: { name: "Strategic", help: "Only an admin can raise one." },
};

const ROLE_LABEL: Record<TierApproverRole, string> = { manager: "Manager or admin", admin: "Admin only" };

const intOrNaN = (v: string) => (v === "" ? Number.NaN : Number(v));
const badHours = (v: number, max: number, min = 0) => !Number.isInteger(v) || v < min || v > max;

/**
 * Approval policy (G1 G2 G3 G4 G7). Admins edit; everyone reads. Five tiers, each with the
 * role that decides it and a turnaround in hours; routine alone can be approved automatically
 * (off by default). A cost at or over the threshold lifts a normal change request to high risk.
 * The rules are enforced by the API and the database, not by this form.
 */
export function ApprovalPolicyCard({ role }: { role: string | null | undefined }) {
  const toast = useToast();
  const { state, reload } = useApiResource(fetchApprovalPolicy);
  const [draft, setDraft] = useState<ApprovalPolicy | null>(null);
  const [saving, setSaving] = useState(false);

  if (state.status === "loading") {
    return (
      <Card>
        <CardBody>
          <LoadingRow label="Loading approval policy" />
        </CardBody>
      </Card>
    );
  }
  if (state.status !== "ready") return null;

  const isAdmin = role === "admin";
  const saved = state.data;
  const value = draft ?? saved;
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  const setTier = (t: Tier, patch: Partial<ApprovalPolicy["tiers"][Tier]>) =>
    setDraft({ ...value, tiers: { ...value.tiers, [t]: { ...value.tiers[t], ...patch } } });
  const thresholdBad = !Number.isFinite(value.currency_threshold) || value.currency_threshold < 0;
  const retroBad = badHours(value.emergency_retro_hours, MAX_RETRO_HOURS, 1);
  const daysBad = badHours(value.schedule_threshold_days, MAX_SCHEDULE_THRESHOLD_DAYS);
  const currencyBad = value.currency !== null && !/^[A-Za-z]{3}$/.test(value.currency);
  const hoursBad = TIERS.some((t) => badHours(value.tiers[t].turnaround_hours, MAX_TURNAROUND_HOURS));
  const invalid = thresholdBad || retroBad || currencyBad || hoursBad || daysBad;

  async function save() {
    setSaving(true);
    try {
      await saveApprovalPolicy(value);
      toast.success("Approval policy saved.");
      setDraft(null);
      reload();
    } catch (e) {
      toast.error(errorText(e, "Could not save the approval policy."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Approval policy</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-secondary">
          Who decides a request depends on its tier. A person who raised a request can never decide it. People who
          cannot decide a tier are not asked, and the server refuses their decision.
        </p>

        <div className="divide-y divide-border-subtle rounded-md border border-border-subtle">
          {TIERS.map((t) => {
            const rule = value.tiers[t];
            const isEmergency = t === "emergency";
            const hoursInvalid = badHours(rule.turnaround_hours, MAX_TURNAROUND_HOURS);
            return (
              <div key={t} className="grid min-w-0 gap-3 p-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)] sm:items-start">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{TIER_COPY[t].name}</p>
                  <p className="text-xs text-ink-muted">{TIER_COPY[t].help}</p>
                </div>
                <Field id={`tier-${t}-role`} label={isEmergency ? "Approves afterwards" : "Decided by"}>
                  {(a11y) => (
                    <Select
                      {...a11y}
                      value={rule.approver_role}
                      disabled={!isAdmin || saving}
                      onChange={(e) => setTier(t, { approver_role: e.target.value as TierApproverRole })}
                      className="w-full"
                    >
                      <option value="manager">{ROLE_LABEL.manager}</option>
                      <option value="admin">{ROLE_LABEL.admin}</option>
                    </Select>
                  )}
                </Field>
                {isEmergency ? (
                  <p className="text-xs text-ink-muted sm:pt-6">The retro window below applies.</p>
                ) : (
                  <Field
                    id={`tier-${t}-hours`}
                    label="Turnaround (hours)"
                    hint="0 means no timer."
                    error={hoursInvalid ? `Use a whole number from 0 to ${MAX_TURNAROUND_HOURS}.` : undefined}
                  >
                    {(a11y) => (
                      <Input
                        {...a11y}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_TURNAROUND_HOURS}
                        value={Number.isNaN(rule.turnaround_hours) ? "" : rule.turnaround_hours}
                        disabled={!isAdmin || saving}
                        onChange={(e) => setTier(t, { turnaround_hours: intOrNaN(e.target.value) })}
                        className="w-full"
                      />
                    )}
                  </Field>
                )}
                {t === "routine" && (
                  <div className="min-w-0 sm:col-span-3">
                    <CheckRow
                      checked={rule.auto_approve}
                      onChange={(v) => setTier(t, { auto_approve: v })}
                      title="Approve automatically when the turnaround passes"
                      description="Off by default. Applies to routine requests only, never to one with a cost or a schedule impact."
                      disabled={!isAdmin || saving}
                    />
                    {rule.auto_approve && (
                      <InlineAlert tone="neutral" className="mt-1">
                        With this on, a routine request nobody decides within {rule.turnaround_hours} hours is approved
                        by policy, with no second person. It is recorded in the audit trail as an automatic approval.
                      </InlineAlert>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Field
            id="schedule-threshold"
            label="High-risk schedule threshold (days)"
            hint="A change that moves the schedule by more than this becomes high risk."
            error={daysBad ? `Use a whole number from 0 to ${MAX_SCHEDULE_THRESHOLD_DAYS}.` : undefined}
          >
            {(a11y) => (
              <Input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_SCHEDULE_THRESHOLD_DAYS}
                value={Number.isNaN(value.schedule_threshold_days) ? "" : value.schedule_threshold_days}
                disabled={!isAdmin || saving}
                onChange={(e) => setDraft({ ...value, schedule_threshold_days: intOrNaN(e.target.value) })}
                className="w-full"
              />
            )}
          </Field>
        </div>

        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <Field
            id="currency-threshold"
            label="High-risk cost threshold"
            hint="A change request costing at least this much becomes high risk."
            error={thresholdBad ? "Use a number of 0 or more." : undefined}
          >
            {(a11y) => (
              <Input
                {...a11y}
                type="number"
                inputMode="decimal"
                min={0}
                value={Number.isNaN(value.currency_threshold) ? "" : value.currency_threshold}
                disabled={!isAdmin || saving}
                onChange={(e) => setDraft({ ...value, currency_threshold: e.target.value === "" ? Number.NaN : Number(e.target.value) })}
                className="w-full"
              />
            )}
          </Field>
          <Field
            id="currency-code"
            label="Currency"
            optional
            hint="A label, such as MYR. Costs are compared as plain numbers in your own currency; nothing is converted."
            error={currencyBad ? "Use a three-letter code." : undefined}
          >
            {(a11y) => (
              <Input
                {...a11y}
                value={value.currency ?? ""}
                maxLength={3}
                disabled={!isAdmin || saving}
                onChange={(e) => setDraft({ ...value, currency: e.target.value === "" ? null : e.target.value.toUpperCase() })}
                className="w-full"
              />
            )}
          </Field>
          <Field
            id="retro-hours"
            label="Emergency approval window (hours)"
            hint="How long an emergency change may stay live before its approval is overdue."
            error={retroBad ? `Use a whole number from 1 to ${MAX_RETRO_HOURS}.` : undefined}
          >
            {(a11y) => (
              <Input
                {...a11y}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_RETRO_HOURS}
                value={Number.isNaN(value.emergency_retro_hours) ? "" : value.emergency_retro_hours}
                disabled={!isAdmin || saving}
                onChange={(e) => setDraft({ ...value, emergency_retro_hours: intOrNaN(e.target.value) })}
                className="w-full"
              />
            )}
          </Field>
        </div>

        {isAdmin ? (
          <Button size="sm" disabled={saving || !dirty || invalid} onClick={save}>
            {saving ? "Saving..." : "Save"}
          </Button>
        ) : (
          <p className="text-xs text-ink-muted">Only workspace admins can change the approval policy.</p>
        )}
      </CardBody>
    </Card>
  );
}
