"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { FormSection } from "@/components/forms/form-shell";
import { createConnector } from "./api";
import { FeatureFields } from "./feature-fields";
import {
  DEFAULT_CONNECT_VALUES,
  errorText,
  validateConnectForm,
  type ConnectFormValues,
  type ConnectorView,
  type FormErrors,
} from "./model";
import { CheckRow, Field, InlineAlert, RadioCards } from "./shared";

/** Field order for "focus the first invalid field" on a failed submit. */
const FIELD_ORDER: (keyof ConnectFormValues)[] = [
  "name",
  "appId",
  "appSecret",
  "verificationToken",
  "digestChatId",
];

const FIELD_IDS: Partial<Record<keyof ConnectFormValues, string>> = {
  name: "lark-name",
  appId: "lark-app-id",
  appSecret: "lark-app-secret",
  verificationToken: "lark-verification-token",
  digestChatId: "lark-connect-chat",
};

/**
 * "Connect" form for a Lark or Feishu self-built app. Title-first and lean:
 * name is pre-filled, mode defaults to webhook, approvals default on, digest
 * off — a first connection needs only the three credentials. The secrets are
 * sent once to the API (which encrypts them at rest) and are never read back
 * or stored in page state after submit.
 */
export function ConnectForm({
  onCreated,
  onCancel,
}: {
  onCreated: (result: { connector: ConnectorView | null; relaySecret: string | null; mode: ConnectFormValues["mode"] }) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<ConnectFormValues>(DEFAULT_CONNECT_VALUES);
  const [errors, setErrors] = useState<FormErrors<ConnectFormValues>>({});
  const [showSecrets, setShowSecrets] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The "Connect" button that revealed this form is gone — land focus on the first field.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const patch = (p: Partial<ConnectFormValues>) => setValues((v) => ({ ...v, ...p }));
  const secretType = showSecrets ? "text" : "password";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const found = validateConnectForm(values);
    setErrors(found);
    const firstInvalid = FIELD_ORDER.find((k) => found[k]);
    if (firstInvalid) {
      const id = FIELD_IDS[firstInvalid];
      if (id) document.getElementById(id)?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createConnector(values);
      // Drop the typed secrets from state before handing control back.
      setValues(DEFAULT_CONNECT_VALUES);
      onCreated({ ...created, mode: values.mode });
    } catch (err) {
      setSubmitError(errorText(err, "Could not connect Lark."));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Field id="lark-name" label="Name" error={errors.name}>
        {(a11y) => (
          <Input
            {...a11y}
            ref={nameRef}
            value={values.name}
            onChange={(e) => patch({ name: e.target.value })}
            disabled={submitting}
            maxLength={80}
            autoComplete="off"
          />
        )}
      </Field>

      <RadioCards
        legend="Region"
        name="lark-region"
        value={values.region}
        onChange={(region) => patch({ region })}
        disabled={submitting}
        options={[
          { value: "lark", label: "Lark (international)", description: "Your app lives on open.larksuite.com." },
          { value: "feishu", label: "Feishu (China)", description: "Your app lives on open.feishu.cn." },
        ]}
      />

      <RadioCards
        legend="How Lark reaches NoPM"
        name="lark-mode"
        value={values.mode}
        onChange={(mode) => patch({ mode })}
        disabled={submitting}
        options={[
          {
            value: "webhook",
            label: "Webhook",
            description: "Lark calls NoPM over HTTPS. Choose this when NoPM is hosted and publicly reachable.",
          },
          {
            value: "long_connection",
            label: "Long connection",
            description: "A small worker you run opens an outbound link. Choose this when NoPM is self-hosted.",
          },
        ]}
      />

      <FormSection
        title="App credentials"
        description="From your self-built app in the Lark developer console. Encrypted at rest and never shown again."
      >
        <div className="space-y-4">
          <Field id="lark-app-id" label="App ID" error={errors.appId}>
            {(a11y) => (
              <Input
                {...a11y}
                value={values.appId}
                onChange={(e) => patch({ appId: e.target.value })}
                disabled={submitting}
                placeholder="cli_…"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <Field id="lark-app-secret" label="App Secret" error={errors.appSecret}>
            {(a11y) => (
              <Input
                {...a11y}
                type={secretType}
                value={values.appSecret}
                onChange={(e) => patch({ appSecret: e.target.value })}
                disabled={submitting}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <Field
            id="lark-verification-token"
            label="Verification Token"
            error={errors.verificationToken}
            hint="Under Events & Callbacks, Encryption Strategy."
          >
            {(a11y) => (
              <Input
                {...a11y}
                type={secretType}
                value={values.verificationToken}
                onChange={(e) => patch({ verificationToken: e.target.value })}
                disabled={submitting}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <Field
            id="lark-encrypt-key"
            label="Encrypt Key"
            optional
            hint="Set one in Lark to also sign and encrypt incoming events."
          >
            {(a11y) => (
              <Input
                {...a11y}
                type={secretType}
                value={values.encryptKey}
                onChange={(e) => patch({ encryptKey: e.target.value })}
                disabled={submitting}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
            )}
          </Field>
          <CheckRow checked={showSecrets} onChange={setShowSecrets} title="Show the values I type" disabled={submitting} />
        </div>
      </FormSection>

      <FormSection title="What to turn on">
        <FeatureFields
          values={values}
          onChange={patch}
          errors={errors}
          disabled={submitting}
          idPrefix="lark-connect"
        />
      </FormSection>

      {submitError && <InlineAlert>{submitError}</InlineAlert>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <Button type="button" variant="ghost" size="md" className="h-11 sm:h-10" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md" className="h-11 sm:h-10" disabled={submitting}>
          {submitting ? (
            <>
              <Spinner size="sm" className="mr-2" /> Connecting…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      </div>
    </form>
  );
}
