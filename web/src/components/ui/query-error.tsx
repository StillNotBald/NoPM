/**
 * QueryError: standard block for a failed data query on a server page.
 *
 *   if (error) return <QueryError what="projects" message={error.message} />;
 *
 * Renders "Failed to load <what>: <message>" in the danger ink, announced to
 * assistive tech via role="alert". Mirrors the inline block previously
 * hand-written in projects/page.tsx.
 */
import { cn } from "@/lib/cn";

export function QueryError({
  what,
  message,
  className,
}: {
  /** Plural noun of what failed to load, e.g. "projects". */
  what: string;
  /** The underlying error message (e.g. Supabase `error.message`). */
  message?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("px-4 py-5 sm:px-6 sm:py-6 lg:px-8", className)}>
      <p role="alert" className="text-sm text-danger-ink">
        Failed to load {what}
        {message ? `: ${message}` : "."}
      </p>
    </div>
  );
}
