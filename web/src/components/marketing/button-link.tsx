import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type MarketingButtonVariant = "primary" | "secondary" | "link";
export type MarketingButtonSize = "md" | "sm";

/**
 * The one definition of a marketing-page call to action. Every public page used
 * to re-implement its own (`bg-accent text-white` was white on #60cdff = 1.79:1
 * in dark mode; focus ring, label and height drifted per copy). The primary
 * pairs with `--accent-ink` exactly like `ui/button.tsx`, the ring is the shared
 * solid `focus-ring`, and the target is 44px tall (36px from `sm` up for the
 * compact size, where a pointer is the norm).
 */
const base =
  "inline-flex items-center justify-center rounded-md font-medium text-sm transition-colors duration-150 focus-ring";

const variants: Record<MarketingButtonVariant, string> = {
  primary: "bg-accent text-accent-ink font-semibold hover:bg-accent-hover",
  secondary: "border border-border-strong text-ink hover:bg-well",
  link: "text-ink-secondary hover:text-ink",
};

const sizes: Record<MarketingButtonSize, string> = {
  md: "min-h-11 px-5",
  sm: "min-h-11 px-3.5 sm:min-h-9",
};

export function marketingButtonClass({
  variant = "primary",
  size = "md",
  block = false,
}: {
  variant?: MarketingButtonVariant;
  size?: MarketingButtonSize;
  /** Full width below `sm` so stacked CTAs carry equal weight on a phone. */
  block?: boolean;
} = {}): string {
  return cn(base, variants[variant], variant === "link" ? "min-h-11 px-1" : sizes[size], block && "w-full sm:w-auto");
}

/** Text nav link used in the marketing headers (44px target below `md`, quiet at rest). */
export const marketingNavLinkClass =
  "min-h-11 items-center rounded-md px-1 text-ink-secondary hover:text-ink focus-ring";

type ButtonLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  variant?: MarketingButtonVariant;
  size?: MarketingButtonSize;
  block?: boolean;
  /**
   * Render a plain `<a>` (full navigation) instead of `next/link`. Use it for
   * non-page targets — `/llms.txt`, `/api/openapi.json`, external URLs — which
   * are route handlers or other origins, not App Router pages.
   */
  plain?: boolean;
};

export function ButtonLink({
  href,
  variant,
  size,
  block,
  plain = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  const classes = cn(marketingButtonClass({ variant, size, block }), className);
  if (plain) {
    return (
      <a href={href} className={classes} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...rest}>
      {children}
    </Link>
  );
}
