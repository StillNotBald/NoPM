"use client";

/**
 * Integrations console — small shared building blocks.
 *
 * Composed from the existing ui primitives only (Button, Input, Spinner,
 * Badge, useToast, useModal); nothing here is a new design primitive, just
 * the form/clipboard/confirm glue that three cards on this page need. Touch
 * targets are >= 44px below `sm` (the repo's phone rule); colours are tokens
 * only so dark mode follows for free.
 */
import { useEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { AlertTriangle, Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { errorText } from "./model";

// ── Field + inputs ──────────────────────────────────────────────────────────

export interface FieldA11y {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby"?: string;
}

/** Label + control + hint/error, wired with htmlFor / aria-describedby / aria-invalid. */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
        {label}
        {optional && <span className="ml-1 font-normal normal-case tracking-normal">(optional)</span>}
      </label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Native <select> in the repo's field style (44px on phones via the `field` utility). */
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "field h-11 rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:h-10 sm:text-sm",
        "focus-ring focus-visible:border-accent disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Checkbox row with a title + one-line description; the whole row is the hit target. */
export function CheckRow({
  checked,
  onChange,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-md py-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="focus-ring mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-border-subtle accent-accent"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        {description && <span className="mt-0.5 block text-xs text-ink-muted">{description}</span>}
      </span>
    </label>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/**
 * Single-choice cards on native radios: keyboard (arrows within the group),
 * screen-reader group semantics and 44px targets come from the platform.
 */
export function RadioCards<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (next: T) => void;
  options: RadioOption<T>[];
  disabled?: boolean;
}) {
  return (
    <fieldset className="min-w-0 space-y-1.5" disabled={disabled}>
      <legend className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-muted">{legend}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <label
              key={o.value}
              className={cn(
                "flex min-h-[44px] min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                selected ? "border-accent bg-accent/10" : "border-border-subtle bg-surface hover:bg-well",
              )}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={selected}
                onChange={() => onChange(o.value)}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{o.label}</span>
                {o.description && <span className="mt-0.5 block text-xs text-ink-secondary">{o.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ── Feedback ────────────────────────────────────────────────────────────────

/** Inline message block. `danger` is announced assertively; the rest politely. */
export function InlineAlert({
  tone = "danger",
  children,
  className,
}: {
  tone?: "danger" | "success" | "neutral";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        tone === "danger" && "bg-danger/15 text-danger-ink",
        tone === "success" && "bg-success/15 text-success-ink",
        tone === "neutral" && "bg-well text-ink-secondary",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Spinner + caption row for a card that is still loading. */
export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2" role="status">
      <Spinner size="sm" />
      <span className="text-sm text-ink-secondary">{label}</span>
    </div>
  );
}

// ── Clipboard ───────────────────────────────────────────────────────────────

/**
 * Copy-to-clipboard button. The visible label flips to "Copied" and a polite
 * live region announces it; a blocked clipboard (insecure context, denied
 * permission) falls back to an error toast instead of failing silently.
 */
export function CopyButton({
  value,
  subject,
  label = "Copy",
  className,
}: {
  value: string;
  /** What is being copied, for the accessible name and announcement ("webhook URL"). */
  subject: string;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy automatically. Select the text and copy it manually.");
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn("h-11 w-full shrink-0 sm:h-8 sm:w-auto", className)}
        onClick={copy}
        aria-label={copied ? `${subject} copied` : `${label} ${subject}`}
      >
        {copied ? <Check size={14} className="mr-1.5" aria-hidden="true" /> : <Copy size={14} className="mr-1.5" aria-hidden="true" />}
        {copied ? "Copied" : label}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${subject} copied to the clipboard` : ""}
      </span>
    </>
  );
}

/** A labelled, select-all value (URL, code, secret) with its copy button. */
export function CopyValue({
  label,
  value,
  subject,
  multiline,
}: {
  label: string;
  value: string;
  subject: string;
  multiline?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        {multiline ? (
          <pre className="min-w-0 select-all overflow-x-auto sm:flex-1 whitespace-pre rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-xs text-ink">
            {value}
          </pre>
        ) : (
          <code className="block min-w-0 select-all break-all sm:flex-1 rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-sm text-ink">
            {value}
          </code>
        )}
        <CopyButton value={value} subject={subject} />
      </div>
    </div>
  );
}

// ── Disclosure ──────────────────────────────────────────────────────────────

/** Native <details> disclosure (keyboard + screen-reader support for free), collapsed by default. */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group rounded-md border border-border-subtle bg-surface", className)}>
      <summary className="focus-ring flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-ink marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <ChevronDown
          size={16}
          className="shrink-0 text-ink-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 border-t border-border-subtle px-3 py-3">{children}</div>
    </details>
  );
}

// ── Confirm dialog ──────────────────────────────────────────────────────────

/**
 * Body for `useModal().open(...)`: a destructive-action confirm that keeps the
 * dialog open and shows the API's message inline if the action fails, and
 * closes itself only on success.
 */
export function ConfirmDialog({
  heading,
  children,
  confirmLabel,
  failureFallback,
  onConfirm,
}: {
  heading: string;
  children: ReactNode;
  confirmLabel: string;
  failureFallback: string;
  onConfirm: () => Promise<void>;
}) {
  const modal = useModal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      modal.close();
    } catch (e) {
      setError(errorText(e, failureFallback));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-full bg-danger/15 p-2">
          <AlertTriangle size={18} className="text-danger-ink" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium text-ink">{heading}</p>
          <div className="space-y-2 text-sm text-ink-secondary">{children}</div>
        </div>
      </div>
      {error && <InlineAlert>{error}</InlineAlert>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={modal.close} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" className="h-11 sm:h-8" onClick={confirm} disabled={busy}>
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
