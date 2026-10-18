"use client";

/** URL-synced project filter (`?project=<id>`; omitted for "all"). */
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function ProjectFilter({
  projects,
  value,
}: {
  projects: Array<{ id: string; name: string }>;
  value: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function onChange(next: string) {
    const params = new URLSearchParams(sp.toString());
    if (!next) params.delete("project");
    else params.set("project", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <select
      aria-label="Filter by project"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="focus-ring h-8 max-w-[220px] rounded-md border border-border-subtle bg-surface px-2 text-sm text-ink"
    >
      <option value="">All projects</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
