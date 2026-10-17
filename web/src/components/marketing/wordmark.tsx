import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The NoPM mark + name, one definition for the landing, case study, sign-in,
 * 404 and error pages (login used a text-only "No[PM]" lockup, the others a
 * square N). The mark pairs `bg-accent` with `text-accent-ink` so it holds in
 * dark mode. Always links home; the link is the 44px target.
 */
export function Wordmark({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-md text-ink focus-ring",
        size === "lg" && "gap-2.5",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center bg-accent font-semibold text-accent-ink",
          size === "lg" ? "h-9 w-9 rounded-[10px] text-lg" : "h-7 w-7 rounded-[8px] text-sm",
        )}
      >
        N
      </span>
      <span className={size === "lg" ? "text-2xl font-semibold tracking-tight" : "font-medium"}>NoPM</span>
    </Link>
  );
}
