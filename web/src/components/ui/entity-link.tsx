"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { entityHref, type EntityKind } from "@/lib/nav/entity-href";

/**
 * Clickable entity reference used everywhere a project/risk/task/etc. name
 * appears. Renders an accent-hover link to the entity's deep-link. Safe inside
 * a clickable row: it stops click propagation so the link wins over a row
 * onClick (e.g. the inspector-opening <tr>). Falls back to plain text when the
 * id is missing.
 */
export function EntityLink({
  kind,
  id,
  projectId,
  refId,
  children,
  className,
  muted,
}: {
  kind: EntityKind;
  id?: string | null;
  projectId?: string | null;
  refId?: string | null;
  children: ReactNode;
  className?: string;
  muted?: boolean;
}) {
  if (!id) {
    return <span className={cn(muted ? "text-ink-secondary" : "text-ink", className)}>{children}</span>;
  }
  return (
    <Link
      href={entityHref(kind, { id, projectId })}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded underline-offset-2 transition-colors",
        "hover:text-accent hover:underline focus-ring",
        muted ? "text-ink-secondary" : "text-ink",
        className,
      )}
    >
      {refId ? (
        <span className="shrink-0 font-mono text-2xs text-ink-muted">{refId}</span>
      ) : null}
      <span className="truncate">{children}</span>
    </Link>
  );
}
