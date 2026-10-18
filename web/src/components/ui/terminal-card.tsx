import { cn } from "@/lib/cn";

/**
 * macOS traffic-light dots — the terminal motif used across the marketing
 * pages, the app header, and the audit history card. One definition so the
 * colors, sizing, and a11y treatment cannot drift between copies.
 */
export function TrafficLights({ size = "sm" }: { size?: "sm" | "md" }) {
  const dot = cn("rounded-full", size === "md" ? "h-3 w-3" : "h-2.5 w-2.5");
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      <span className={cn(dot, "bg-terminal-red")} />
      <span className={cn(dot, "bg-terminal-amber")} />
      <span className={cn(dot, "bg-terminal-green")} />
    </span>
  );
}

/**
 * A dark terminal window card. The surface is intentionally fixed near-black
 * in BOTH themes — a terminal is dark; that is the brand moment.
 */
export function TerminalCard({
  title,
  children,
  className,
}: {
  /** Text shown in the chrome bar next to the traffic lights. */
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border-subtle bg-terminal-surface", className)}>
      <div className="flex items-center gap-1.5 border-b border-terminal-border px-4 py-2.5">
        <TrafficLights />
        <span className="ml-2 font-mono text-xs text-terminal-text-muted">{title}</span>
      </div>
      {children}
    </div>
  );
}
