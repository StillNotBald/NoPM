/**
 * The three-wedge argument — one source of truth shared by the landing page
 * and the case study, so the copy cannot fork between them.
 *
 * Rendered as a spec sheet (key / value rows), not a card grid — it reads
 * like a CLI flags table, which is the actual register this product speaks.
 */

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6 sm:py-6">
      <dt className="font-mono text-xs font-semibold uppercase tracking-wide text-accent">{k}</dt>
      <dd className="text-sm leading-relaxed text-ink-secondary">{children}</dd>
    </div>
  );
}

export function WedgeGrid() {
  return (
    <dl className="divide-y divide-border-subtle border-y border-border-subtle">
      <Field k="agent-native">
        Every action is a REST endpoint: scoped{" "}
        <code className="font-mono text-xs text-ink">resource:action</code> tokens, OpenAPI, an{" "}
        <code className="font-mono text-xs text-ink">llms.txt</code> index, a{" "}
        <code className="font-mono text-xs text-ink">nopm</code> CLI and MCP. Any agent drives it
        the same way the console does.
      </Field>
      <Field k="governed">
        Every mutation writes one append-only audit row. Deletes need four-eyes: a{" "}
        <em>different</em> checker approves, enforced by a Postgres{" "}
        <code className="font-mono text-xs text-ink">CHECK</code>. Even a service key
        can&apos;t rewrite history.
      </Field>
      <Field k="governed triangle">
        Timeline, resource and budget changes pass one audit and sign-off gate. NoPM records who
        changed what and who approved it. It is not a scheduler, time tracker or ERP.
      </Field>
    </dl>
  );
}
