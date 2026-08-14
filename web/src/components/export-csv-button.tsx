import { Download } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Export CSV button (L-27) — a plain link into the governed GET /api/export
 * route. No client JS needed: the browser handles the Content-Disposition
 * download itself. `href` should already include `?entity=...` plus any
 * active filters the caller wants honored (see GET /api/export docs —
 * filters mirror the entity's list API 1:1).
 *
 * R-63: touch target is >=44px unconditionally, narrowed to the desktop
 * button height only at sm+ (same idiom as registers/filter-bar.tsx).
 */
export function ExportCsvButton({
  href,
  label = "Export CSV",
  className,
}: {
  href: string;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-border-subtle",
        "bg-surface px-3 text-sm font-medium text-ink transition-colors duration-150",
        "hover:bg-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        "sm:h-9",
        className,
      )}
    >
      <Download size={14} />
      {label}
    </a>
  );
}
