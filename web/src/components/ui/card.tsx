import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border-subtle bg-surface", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle px-5 py-4", className)}
      {...props}
    />
  );
}

/**
 * Card heading. Defaults to `h2`: a console page has one `h1` (PageHeader) and
 * its cards are its sections, so the old fixed `h3` made every page jump h1 to
 * h3. Pass `as="h3"` / `"h4"` when the card sits under another section heading.
 */
export function CardTitle({
  as: Tag = "h2",
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
  return <Tag className={cn("text-sm font-medium text-ink", className)} {...props} />;
}

type CardBodyPad = "default" | "compact" | "none";

const padClass: Record<CardBodyPad, string> = {
  default: "p-5",
  compact: "p-2",
  none: "p-0",
};

export function CardBody({
  className,
  pad = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { pad?: CardBodyPad }) {
  return <div className={cn(padClass[pad], className)} {...props} />;
}
