import { cn } from "@/lib/cn";

/**
 * The proof terminal's transcript, one source for the landing and the case
 * study (they carried two hand-aligned copies, and on a 390px phone both were
 * clipped — "approv", the whole `target` column — in a horizontal scroller).
 *
 * Below `sm` the text soft-wraps the way a real terminal does and the audit
 * table drops `created_at` (real `nopm audit` columns, same order, minus the
 * first) so it fits ~39 columns; from `sm` up it keeps the full row and, if a
 * very narrow container ever overflows, scrolls.
 */
export function ProofTranscript({ className }: { className?: string }) {
  return (
    <pre
      className={cn(
        "px-4 py-5 font-mono text-[12px] leading-relaxed text-white/80 sm:px-5 sm:text-[13px]",
        "whitespace-pre-wrap break-words sm:overflow-x-auto sm:whitespace-pre sm:break-normal",
        className,
      )}
    >
      {`$ nopm tasks rm task_8f3a \\
    --reason "superseded by revised cutover plan"
⏸ delete requested — pending a checker's
  approval (four-eyes)

$ nopm approve req_2c91
✓ approved & committed
  # a different person's token: task:delete:approve
  # one immutable audit row written

$ nopm audit --limit 1
`}
      <span className="sm:hidden">
        {`actor_label      action       target
checker (agent)  task.delete  task_8f3a`}
      </span>
      <span className="hidden sm:inline">
        {`created_at   actor_label      action       target
2026-06-08T… checker (agent)  task.delete  task_8f3a`}
      </span>
    </pre>
  );
}
