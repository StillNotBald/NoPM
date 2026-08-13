/**
 * The three-wedge argument — one source of truth shared by the landing page
 * and the case study, so the copy cannot fork between them.
 */

function Wedge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-6">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="inline-block h-3.5 w-[3px] rounded-[1px] bg-accent" aria-hidden />
        {title}
      </h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-secondary">{children}</p>
    </div>
  );
}

/** One bordered ledger strip, hairline-divided — not three floating cards. */
export function WedgeGrid() {
  return (
    <div className="grid overflow-hidden rounded-lg border border-border-subtle divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Wedge title="AI-native / agent-operable">
        Every action is a stable REST endpoint. Scoped{" "}
        <code className="font-mono text-xs">resource:action</code> Bearer tokens, an OpenAPI spec,
        an <code className="font-mono text-xs">llms.txt</code> discovery index, and a{" "}
        <code className="font-mono text-xs">nopm</code> CLI let any agent drive the tool over plain
        HTTP — identical to the web console.
      </Wedge>
      <Wedge title="Institutional governance">
        Every mutation writes exactly one append-only audit row. Destructive deletes need
        four-eyes: a maker requests, a <em>different</em> checker approves (enforced by Postgres{" "}
        <code className="font-mono text-xs">CHECK</code> constraints). Even a service key
        can&apos;t rewrite history.
      </Wedge>
      <Wedge title="The whole triangle">
        Timeline, resource, and budget in one governed model — the gap most lite PM tools miss.
        Over-allocation surfaces as a clash; spend rolls up to EVM variance; a locked timeline
        forces a rebaseline sign-off.
      </Wedge>
    </div>
  );
}
