import { Trash2 } from "lucide-react";
import type { ChildCountLine } from "@/lib/review/deletion-target";

/**
 * D2 / Q-GOV-12: what approving a PROJECT deletion also destroys. Renders the
 * child counts recorded on the request, with governed records (change
 * requests, decisions, documents, rebaselines) called out. Server-renderable.
 */
export function ChildCountsNote({ lines }: { lines: ChildCountLine[] }) {
  if (lines.length === 0) return null;
  const governed = lines.filter((l) => l.governed);
  return (
    <div role="note" className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-snug text-danger-ink">
      <p className="flex items-center gap-1.5 font-semibold">
        <Trash2 size={12} aria-hidden="true" /> Approving also deletes:
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        {lines.map((l) => (
          <li key={l.key} className="tabular-nums">
            {l.count} {l.label}
          </li>
        ))}
      </ul>
      {governed.length > 0 && (
        <p className="mt-1">
          Governed records ({governed.map((l) => l.label).join(", ")}) go with it, without a separate audit entry each.
        </p>
      )}
    </div>
  );
}
