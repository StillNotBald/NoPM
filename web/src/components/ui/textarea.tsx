import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Multi-line counterpart of <Input>: same border, radius, placeholder and the
 * solid `focus-ring`. Height is the caller's (`rows` / `min-h-*`); the `field`
 * utility keeps it full-width and never narrower than a 44px touch target.
 */
export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "field rounded-md border border-border-subtle bg-canvas px-3 py-2 text-base text-ink sm:text-sm",
        "placeholder:text-ink-muted focus-ring focus-visible:border-accent disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
