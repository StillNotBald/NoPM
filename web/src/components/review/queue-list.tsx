"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { cn } from "@/lib/cn";
import type { ReviewItem, ReviewKind } from "@/lib/review/gather";

// ── Kind metadata ─────────────────────────────────────────────────────────────

const kindMeta: Record<
  ReviewKind,
  { label: string; chipClass: string; dotClass: string }
> = {
  approval: {
    label: "Pending Approvals",
    chipClass:
      "rounded-full bg-danger/10 px-2 py-0.5 font-mono text-xs font-medium text-danger",
    dotClass: "text-danger",
  },
  rebaseline: {
    label: "Rebaseline Sign-offs",
    chipClass:
      "rounded-full bg-warning/10 px-2 py-0.5 font-mono text-xs font-medium text-warning",
    dotClass: "text-warning",
  },
  change: {
    label: "Change Requests in Review",
    chipClass:
      "rounded-full bg-[#7c3aed]/10 px-2 py-0.5 font-mono text-xs font-medium text-[#7c3aed]",
    dotClass: "text-[#7c3aed]",
  },
  risk: {
    label: "High / Critical Risks",
    chipClass:
      "rounded-full bg-[#ea580c]/10 px-2 py-0.5 font-mono text-xs font-medium text-[#ea580c]",
    dotClass: "text-[#ea580c]",
  },
  clash: {
    label: "Unresolved Clashes",
    chipClass:
      "rounded-full bg-info/10 px-2 py-0.5 font-mono text-xs font-medium text-info",
    dotClass: "text-info",
  },
  document: {
    label: "Documents in Review",
    chipClass:
      "rounded-full bg-sunken px-2 py-0.5 font-mono text-xs font-medium text-ink-muted",
    dotClass: "text-ink-muted",
  },
};

// ── Kind badge shown on each row ──────────────────────────────────────────────

function kindTone(kind: ReviewKind) {
  switch (kind) {
    case "approval":
      return "danger" as const;
    case "rebaseline":
      return "warning" as const;
    case "change":
      return "neutral" as const; // colour carried by the violet group chip
    case "risk":
      return "neutral" as const; // colour comes from Severity dot; badge stays neutral
    case "clash":
      return "info" as const;
    case "document":
      return "neutral" as const;
  }
}

// ── Age chip ──────────────────────────────────────────────────────────────────

function AgeChip({ days }: { days: number }) {
  const label =
    days === 0 ? "today" : days === 1 ? "1d" : `${days}d`;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[11px] tabular-nums text-ink-muted",
        days >= 7 && "text-warning",
        days >= 14 && "text-danger",
      )}
    >
      {label}
    </span>
  );
}

// ── Single row ────────────────────────────────────────────────────────────────

function ReviewRow({ item }: { item: ReviewItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken"
    >
      {/* Kind badge */}
      <Badge tone={kindTone(item.kind)} className="shrink-0 capitalize">
        {item.kind}
      </Badge>

      {/* Title */}
      <span className="min-w-0 flex-1 truncate font-medium text-ink">
        {item.title}
      </span>

      {/* Project chip */}
      {item.project && (
        <span className="shrink-0 rounded bg-sunken border border-border-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          {item.project}
        </span>
      )}

      {/* Severity (risks + clashes) */}
      {item.severity && (
        <Severity level={item.severity} className="shrink-0" />
      )}

      {/* Age */}
      <AgeChip days={item.ageDays} />

      {/* Action label */}
      <span className="shrink-0 rounded-md bg-accent px-2 py-1 font-mono text-[11px] font-medium text-accent-ink">
        {item.actionLabel}
      </span>
    </Link>
  );
}

// ── Group section ─────────────────────────────────────────────────────────────

function GroupSection({
  kind,
  items,
}: {
  kind: ReviewKind;
  items: ReviewItem[];
}) {
  const meta = kindMeta[kind];
  return (
    <section className="rounded-lg border border-border-subtle bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-4">
        <h3 className="text-sm font-medium text-ink">{meta.label}</h3>
        <span className={meta.chipClass}>{items.length}</span>
      </div>

      {/* Rows */}
      <div className="p-2 space-y-0.5">
        {items.map((item) => (
          <ReviewRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

// The ordered display sequence (approvals first, documents last)
const KIND_ORDER: ReviewKind[] = [
  "approval",
  "rebaseline",
  "change",
  "risk",
  "clash",
  "document",
];

export function QueueList({ items }: { items: ReviewItem[] }) {
  // Group by kind, preserving sort order within each group (already sorted by gather)
  const byKind = new Map<ReviewKind, ReviewItem[]>();
  for (const kind of KIND_ORDER) byKind.set(kind, []);
  for (const item of items) {
    byKind.get(item.kind)!.push(item);
  }

  const presentKinds = KIND_ORDER.filter(
    (k) => (byKind.get(k)?.length ?? 0) > 0,
  );

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <span
          className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success"
          aria-hidden
        >
          {/* checkmark */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M20 6 9 17l-5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div>
          <p className="font-medium text-ink">Queue clear</p>
          <p className="mt-1 text-sm text-ink-muted">
            No items need your attention right now.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {presentKinds.map((kind) => (
        <GroupSection
          key={kind}
          kind={kind}
          items={byKind.get(kind)!}
        />
      ))}
    </div>
  );
}
