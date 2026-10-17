"use client";

import { Input } from "@/components/ui/input";
import { WEEKDAYS } from "./format";
import type { FeatureValues, FormErrors } from "./model";
import { CheckRow, Field, Select } from "./shared";

/**
 * The two Lark features an admin can switch on — approvals from chat and the
 * weekly digest. Shared by the connect form and the edit-settings panel so
 * both behave (and validate) identically. Digest details stay hidden until
 * the digest is switched on (default-calm, opt-in power).
 */
export function FeatureFields({
  values,
  onChange,
  errors,
  disabled,
  idPrefix,
}: {
  values: FeatureValues;
  onChange: (patch: Partial<FeatureValues>) => void;
  errors: FormErrors<FeatureValues>;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <div className="space-y-1">
      <CheckRow
        checked={values.approvalsEnabled}
        onChange={(approvalsEnabled) => onChange({ approvalsEnabled })}
        disabled={disabled}
        title="Approve from chat"
        description="Send approval requests to linked approvers as chat cards with Approve and Reject buttons."
      />
      <CheckRow
        checked={values.digestEnabled}
        onChange={(digestEnabled) => onChange({ digestEnabled })}
        disabled={disabled}
        title="Weekly digest"
        description="Post a portfolio summary to a group chat once a week."
      />
      {values.digestEnabled && (
        <div className="grid grid-cols-1 gap-3 pb-1 pt-2 sm:ml-7 sm:grid-cols-[minmax(0,1fr)_11rem]">
          <Field
            id={`${idPrefix}-chat`}
            label="Group chat ID"
            error={errors.digestChatId}
            hint="The bot must be a member of this group."
          >
            {(a11y) => (
              <Input
                {...a11y}
                value={values.digestChatId}
                onChange={(e) => onChange({ digestChatId: e.target.value })}
                disabled={disabled}
                placeholder="oc_…"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <Field id={`${idPrefix}-weekday`} label="Weekday (UTC)">
            {(a11y) => (
              <Select
                {...a11y}
                value={values.digestWeekday}
                onChange={(e) => onChange({ digestWeekday: Number(e.target.value) })}
                disabled={disabled}
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </div>
  );
}
