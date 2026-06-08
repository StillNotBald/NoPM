import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/cn";

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-md border border-border-subtle bg-canvas px-3 text-base text-ink sm:h-10 sm:text-sm",
        "placeholder:text-ink-muted focus:outline-none",
        "focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
        className,
      )}
      {...props}
    />
  );
}
