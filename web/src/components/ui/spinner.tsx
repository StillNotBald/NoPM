import { cn } from "@/lib/cn";

const dimension = { sm: "size-4 border-2", md: "size-6 border-[3px]", lg: "size-8 border-4" } as const;

/**
 * Busy indicator: a bordered ring with one accent-coloured quarter that
 * spins. `motion-reduce` swaps the rotation for a gentle pulse so the signal
 * stays visible without movement.
 */
export function Spinner({ size = "md", className }: { size?: keyof typeof dimension; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block shrink-0 animate-spin rounded-full border-solid border-accent/20 border-t-accent motion-reduce:animate-pulse",
        dimension[size],
        className,
      )}
    />
  );
}
