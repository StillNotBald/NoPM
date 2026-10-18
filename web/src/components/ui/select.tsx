import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Native <select> in the same field style as <Input>: 44px below sm, 40px
 * from sm up, the solid `focus-ring` (not a faint ring-accent/30), and
 * `disabled` dimming. Pair with <Field> for the label.
 */
export function Select({
  className,
  ref,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return (
    <select
      ref={ref}
      className={cn(
        "field h-11 rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:h-10 sm:text-sm",
        "focus-ring focus-visible:border-accent disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
