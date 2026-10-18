"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { SegmentedControl, type SegmentOption } from "@/components/ui/segmented-control";
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
      "rounded-full bg-danger/10 px-2 py-0.5 font-mono text-xs font-medium text-danger-ink",
    dotClass: "text-danger-ink",
  },
  rebaseline: {
    label: "Rebaseline Sign-offs",
    chipClass:
      "rounded-full bg-warning/10 px-2 py-0.5 font-mono text-xs font-medium text-warning-ink",
    dotClass: "text-warning-ink",
  },
  change: {
    label: "Change Requests in Review",
    chipClass:
      "rounded-full bg-change/10 px-2 py-0.5 font-mono text-xs font-medium text-change-ink",
    dotClass: "text-change-ink",
  },
  risk: {
    label: "High / Critical Risks",
    chipClass:
      "rounded-full bg-sev-high/10 px-2 py-0.5 font-mono text-xs font-medium text-sev-high-ink",
    dotClass: "text-sev-high-ink",
  },
  clash: {
    label: "Unresolved Clashes",
    chipClass:
      "rounded-full bg-info/10 px-2 py-0.5 font-mono text-xs font-medium text-info-ink",
    dotClass: "text-info-ink",
  },
  document: {
    label: "Documents in Review",
    chipClass:
      "rounded-full bg-well px-2 py-0.5 font-mono text-xs font-medium text-ink-muted",
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
        "shrink-0 font-mono text-2xs tabular-nums text-ink-muted",
        days >= 7 && "text-warning-ink",
        days >= 14 && "text-danger-ink",
      )}
    >
      {label}
    </span>
  );
}

// ── Row content (shared between link and button rows) ─────────────────────────

const TIER_TEXT: Record<string, string> = {
  routine: "Routine",
  normal: "Normal",
  high_risk: "High risk",
  emergency: "Emergency",
  strategic: "Strategic",
};

function RowContent({ item }: { item: ReviewItem }) {
  // The server says whether THIS viewer may decide the item; when they can't,
  // the row reads "View" (never an Approve / Reject that would be refused).
  const blocked = item.decide !== undefined && !item.decide.canDecide;
  const raisedByMe = item.decide?.block === "you_raised" || item.decide?.block === "your_token_raised";
  return (
    <>
      {/* Kind badge */}
      <Badge tone={kindTone(item.kind)} className="shrink-0 capitalize">
        {item.kind}
      </Badge>

      {/* Title — full row width on phones (its own line once the row
          wraps, up to two lines) so it isn't squeezed to a handful of
          characters next to four other chips; reverts to sharing the row
          inline, one line, at sm+. */}
      <span
        className="line-clamp-2 w-full min-w-0 break-words font-medium text-ink sm:line-clamp-1 sm:w-auto sm:flex-1"
        title={item.title}
      >
        {item.title}
      </span>

      {/* Project chip */}
      {item.project && (
        <span className="shrink-0 rounded bg-well border border-border-subtle px-1.5 py-0.5 font-mono text-2xs text-ink-muted">
          {item.project}
        </span>
      )}

      {/* Severity (risks + clashes) */}
      {item.severity && (
        <Severity level={item.severity} className="shrink-0" />
      )}

      {raisedByMe && <span className="shrink-0 text-2xs text-ink-muted">raised by you</span>}

      {/* UAT-005: tier and decision deadline */}
      {item.tier && (
        <span className="shrink-0 rounded border border-border-subtle bg-well px-1.5 py-0.5 text-2xs text-ink-secondary">
          {TIER_TEXT[item.tier] ?? item.tier}
        </span>
      )}
      {item.deadline && (
        <span className={cn("shrink-0 text-2xs", item.overdue ? "font-medium text-danger-ink" : "text-ink-muted")}>
          {item.overdue ? "overdue since" : "decide by"} {item.deadline.slice(0, 10)}
        </span>
      )}

      {/* Age */}
      <AgeChip days={item.ageDays} />

      {/* Action label */}
      <span
        className={cn(
          "shrink-0 rounded-md px-2 py-1 font-mono text-2xs font-medium",
          blocked ? "bg-well text-ink-secondary" : "bg-accent text-accent-ink",
        )}
      >
        {blocked ? "View" : item.actionLabel}
      </span>
    </>
  );
}

// ── Row variants: inspector (approval/change) vs deep-link navigation ─────────

// min-h-[44px] is the touch-target floor; flex-wrap lets a row break onto a
// second line on phones instead of truncating every chip down to nothing —
// sm:flex-nowrap restores the exact single-line desktop row.
const ROW_BASE =
  "flex min-h-[44px] flex-wrap items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-well cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:flex-nowrap";

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

  const options: SegmentOption<FilterKind>[] = visibleTabs.map((tab) => ({
    value: tab.key,
    label: tab.label,
    count: counts.get(tab.key) ?? 0,
  }));

  // A real single-select (radiogroup, arrow keys, roving tab stop) rather than
  // a tablist with no panels.
  return (
    <SegmentedControl<FilterKind>
      label="Filter review queue by kind"
      options={options}
      value={active}
      onChange={onChange}
      size="md"
    />
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
          className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success-ink"
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
