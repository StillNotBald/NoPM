/**
 * PageContainer: the one page-width wrapper for console pages.
 *
 *   width="default" -> max-w-6xl      (registers, dashboards)
 *   width="narrow"  -> max-w-4xl      (forms, settings, detail reading)
 *   width="wide"    -> max-w-[1400px] (boards, timelines, wide tables)
 *
 * Carries the standard responsive gutters (px-4 sm:px-6 lg:px-8).
 * Not yet adopted by pages.
 */
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type PageWidth = "default" | "narrow" | "wide";

const widths: Record<PageWidth, string> = {
  default: "max-w-6xl",
  narrow: "max-w-4xl",
  wide: "max-w-[1400px]",
};

export function PageContainer({
  width = "default",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { width?: PageWidth }) {
  return (
    <div
      className={cn("mx-auto px-4 py-5 sm:px-6 sm:py-6 lg:px-8", widths[width], className)}
      {...props}
    />
  );
}
