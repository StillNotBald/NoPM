import { cn } from "@/lib/cn";

const sizes = { sm: 16, md: 24, lg: 32 } as const;

export function Spinner({ size = "md", className }: { size?: keyof typeof sizes; className?: string }) {
  const px = sizes[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("animate-spin text-accent", className)}
      aria-label="Loading"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
