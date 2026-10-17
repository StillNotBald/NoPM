"use client";

/**
 * URL-driven status filter for the governance queues: wraps SegmentedControl
 * and writes the selection to `?<param>=` (omitted for the default value), so
 * the filtered view is shareable and server-rendered.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SegmentedControl, type SegmentOption } from "@/components/ui/segmented-control";

export function UrlFilter({
  param = "status",
  label,
  options,
  value,
  defaultValue,
}: {
  param?: string;
  label: string;
  options: SegmentOption[];
  value: string;
  defaultValue: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function onChange(next: string) {
    const params = new URLSearchParams(sp.toString());
    if (next === defaultValue) params.delete(param);
    else params.set(param, next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return <SegmentedControl label={label} options={options} value={value} onChange={onChange} size="sm" />;
}
