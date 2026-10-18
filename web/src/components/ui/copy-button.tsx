"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

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
        className={cn("w-full shrink-0 sm:w-auto", className)}
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
          <pre className="min-w-0 select-all overflow-x-auto whitespace-pre rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-xs text-ink sm:flex-1">
            {value}
          </pre>
        ) : (
          <code className="block min-w-0 select-all break-all rounded-md border border-border-subtle bg-canvas px-3 py-2 font-mono text-sm text-ink sm:flex-1">
            {value}
          </code>
        )}
        <CopyButton value={value} subject={subject} />
      </div>
    </div>
  );
}
