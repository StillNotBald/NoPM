import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";

type Size = "md" | "sm";

// md = header / sheet chrome: 44px below lg, the original 40px at lg+.
// sm = in-card icon actions: 44px below sm, a compact 32px from sm up.
const sizes: Record<Size, string> = {
  md: "h-11 w-11 lg:h-10 lg:w-10",
  sm: "h-11 w-11 sm:h-8 sm:w-8",
};

/**
 * Icon-only button. `label` is required and becomes the accessible name, so an
 * unlabeled icon button is a type error rather than a code-review catch.
 * Ghost styling (secondary ink, sunken hover); pass `className` to tint an
 * active/pressed state, e.g. `aria-pressed` + `text-accent`.
 */
export function IconButton({
  label,
  size = "md",
  className,
  children,
  type = "button",
  ref,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  label: string;
  size?: Size;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        "grid shrink-0 place-items-center rounded-md text-ink-secondary transition-colors duration-150",
        "hover:bg-well focus-ring disabled:pointer-events-none disabled:opacity-50",
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
