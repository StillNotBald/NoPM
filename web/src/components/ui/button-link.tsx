import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

/**
 * A next/link that looks and behaves like <Button>: same variants, sizes,
 * focus ring, 44px touch floor below sm, and `accent-ink` (never hard-coded
 * white) on the accent fill. Use it for navigation; use <Button> for actions.
 */
export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link className={buttonClass({ variant, size, className })} {...props} />;
}
