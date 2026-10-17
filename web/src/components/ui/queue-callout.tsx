/**
 * QueueCallout: "N decisions are waiting" banner for pending
 * approvals/requests. Accent-tinted, one line, optional link action.
 *
 *   <QueueCallout count={3} noun="deletion request" href="/decisions" />
 *
 * Renders nothing when count is 0. Pluralises `noun` by appending "s"
 * (override with `plural`). Carries its own `mb-4` (beats a parent's `space-y-*`);
 * a `className` margin replaces it, so pass `mb-3` to tuck a sibling under it.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

export function QueueCallout({
  count,
  noun = "decision",
  plural,
  href,
  actionLabel = "Review",
  children,
  className,
}: {
  count: number;
  noun?: string;
  plural?: string;
  href?: string;
  actionLabel?: string;
  /** Optional extra detail rendered after the headline. */
  children?: ReactNode;
  className?: string;
}) {
  if (count <= 0) return null;
  const label = count === 1 ? noun : (plural ?? `${noun}s`);
  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm",
        className,
      )}
    >
      <p className="text-ink">
        <span className="font-mono font-semibold tabular-nums">{count}</span> pending {label}
        {children && <span className="ml-2 text-ink-secondary">{children}</span>}
      </p>
      {href && (
        <Link href={href} className="focus-ring rounded-sm font-medium text-accent hover:underline">
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
