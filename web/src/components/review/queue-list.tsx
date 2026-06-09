"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { cn } from "@/lib/cn";
import { useInspector } from "@/components/layout/app-shell";
import { ApprovalInlineAction, ChangeInlineAction } from "@/components/review/inline-action";
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

// ── Filter tabs metadata ──────────────────────────────────────────────────────

type FilterKind = "all" | ReviewKind;

const FILTER_TABS: { key: FilterKind; label: string }[] = [
  { key: "all", label: "All" },
  { key: "approval", label: "Approvals" },
  { key: "change", label: "Changes" },
  { key: "risk", label: "Risks" },
  { key: "clash", label: "Clashes" },
  { key: "document", label: "Docs" },
  { key: "rebaseline", label: "Rebaselines" },
];

// ── Kind badge tone ───────────────────────────────────────────────────────────

function kindTone(kind: ReviewKind) {
  switch (kind) {
    case "approval":
      return "danger" as const;
    case "rebaseline":
      return "warning" as const;
    case "change":
      return "neutral" as const;
    case "risk":
      return "neutral" as const;
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

// ── Row content (shared between link and button rows) ─────────────────────────

function RowContent({ item }: { item: ReviewItem }) {
  return (
    <>
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
    </>
  );
}

// ── Row variants: inspector (approval/change) vs deep-link navigation ─────────

const ROW_BASE =
  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

function InspectorRow({
  item,
  onOpen,
}: {
  item: ReviewItem;
  onOpen: (item: ReviewItem) => void;
}) {
  return (
    <button
      type="button"
      className={ROW_BASE + " w-full text-left"}
      onClick={() => onOpen(item)}
    >
      <RowContent item={item} />
    </button>
  );
}

function LinkRow({ item }: { item: ReviewItem }) {
  return (
    <Link href={item.href} className={ROW_BASE}>
      <RowContent item={item} />
    </Link>
  );
}

// ── Single row dispatcher ──────────────────────────────────────────────────────

function ReviewRow({
  item,
  onOpen,
}: {
  item: ReviewItem;
  onOpen: (item: ReviewItem) => void;
}) {
  // These kinds get an inline inspector; the rest deep-link.
  if (item.kind === "approval" || item.kind === "change") {
    return <InspectorRow item={item} onOpen={onOpen} />;
  }
  return <LinkRow item={item} />;
}

// ── Group section ─────────────────────────────────────────────────────────────

function GroupSection({
  kind,
  items,
  onOpen,
}: {
  kind: ReviewKind;
  items: ReviewItem[];
  onOpen: (item: ReviewItem) => void;
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
          <ReviewRow key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

function FilterTabs({
  items,
  active,
  onChange,
}: {
  items: ReviewItem[];
  active: FilterKind;
  onChange: (k: FilterKind) => void;
}) {
  // Count per kind
  const counts = new Map<FilterKind, number>([["all", items.length]]);
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }

  // Only show tabs that have items (always show "all")
  const visibleTabs = FILTER_TABS.filter(
    (t) => t.key === "all" || (counts.get(t.key) ?? 0) > 0,
  );

  if (visibleTabs.length <= 1) return null; // nothing to filter

  return (
    <div
      role="tablist"
      aria-label="Filter review queue by kind"
      className="flex flex-wrap gap-1.5"
    >
      {visibleTabs.map((tab) => {
        const count = counts.get(tab.key) ?? 0;
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            type="button"
            onClick={() => onChange(tab.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs font-medium transition-colors",
              isActive
                ? "border-border-strong bg-canvas text-ink shadow-sm"
                : "border-border-subtle bg-surface text-ink-secondary hover:bg-sunken hover:text-ink",
            )}
          >
            <span>{tab.label}</span>
            {count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                  isActive
                    ? "bg-accent text-accent-ink"
                    : "bg-sunken text-ink-muted",
                )}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
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
  const inspector = useInspector();
  const [activeFilter, setActiveFilter] = useState<FilterKind>("all");

  // Open inspector for actionable kinds
  function handleOpen(item: ReviewItem) {
    if (item.kind === "approval") {
      inspector.open(
        <ApprovalInlineAction item={item} />,
        "Deletion Request",
      );
    } else if (item.kind === "change") {
      inspector.open(
        <ChangeInlineAction item={item} />,
        "Change Request — Decide",
      );
    }
  }

  // Apply kind filter
  const filtered =
    activeFilter === "all"
      ? items
      : items.filter((i) => i.kind === activeFilter);

  // Group by kind, preserving sort order within each group (already sorted by gather)
  const byKind = new Map<ReviewKind, ReviewItem[]>();
  for (const kind of KIND_ORDER) byKind.set(kind, []);
  for (const item of filtered) {
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
      {/* Filter tabs — rendered above the groups */}
      <FilterTabs
        items={items}
        active={activeFilter}
        onChange={setActiveFilter}
      />

      {/* Filtered empty state */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface px-5 py-10 text-center">
          <p className="text-sm text-ink-muted">
            No <span className="font-medium text-ink">{activeFilter}</span> items in the queue.
          </p>
        </div>
      ) : (
        presentKinds.map((kind) => (
          <GroupSection
            key={kind}
            kind={kind}
            items={byKind.get(kind)!}
            onOpen={handleOpen}
          />
        ))
      )}
    </div>
  );
}
