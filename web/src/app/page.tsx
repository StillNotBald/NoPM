import Link from "next/link";
import { DemoLoginButton } from "@/components/demo-login-button";

export const metadata = {
  title: "NoPM — project governance your AI agent can operate",
  description:
    "A lite, API-first project-management tool your AI agent drives like the aws/supabase CLIs. Immutable audit, scoped tokens, four-eyes approval — enforced in the data layer.",
};

function Wedge({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-6">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{children}</p>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-sm font-semibold text-white">
            N
          </span>
          <span className="font-medium">NoPM</span>
        </div>
        <nav className="flex items-center gap-5 text-sm text-ink-secondary">
          <Link href="/case-study" className="hover:text-ink">Case study</Link>
          <a href="/llms.txt" className="hidden sm:inline-flex hover:text-ink">Agent API</a>
          <a href="/api/openapi.json" className="hidden sm:inline-flex hover:text-ink">OpenAPI</a>
          <Link href="/login" className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover">
            Open console
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-5xl px-6 pb-10 pt-16">
        <p className="text-sm font-medium uppercase tracking-widest text-accent">
          AI-native · governance-grade · lite
        </p>
        <h1 className="mt-4 max-w-3xl font-serif text-4xl sm:text-5xl leading-[1.1] text-ink">
          Project governance your AI agent can actually operate.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-secondary">
          NoPM is a lite, API-first project-management tool — like the <code className="font-mono text-ink">aws</code> or{" "}
          <code className="font-mono text-ink">supabase</code> CLIs, but for project governance. Your own agent drives it
          over a documented REST API. Immutable audit, scoped tokens, and four-eyes approval are enforced in the data
          layer — not bolted onto the UI.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <DemoLoginButton />
          <Link href="/login" className="rounded-md border border-border-strong px-5 py-2.5 font-medium text-ink hover:bg-sunken">
            Sign in →
          </Link>
          <a href="/llms.txt" className="rounded-md border border-border-strong px-5 py-2.5 font-medium text-ink hover:bg-sunken">
            Read the agent API
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-8">
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-[#0e0e0f]">
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" aria-hidden />
            <span className="ml-3 font-mono text-xs text-white/40">an agent drives NoPM</span>
          </div>
          <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed text-white/80">
{`$ nopm tasks rm task_8f3a --reason "superseded by revised cutover plan"
⏸ delete requested — pending a checker's approval (four-eyes)

$ nopm approve req_2c91          # a different token: task:delete:approve
✓ approved & committed           # one immutable audit row written

$ nopm audit --limit 1
created_at            actor_label     action        target
2026-06-08T…          checker (agent) task.delete   task 8f3a`}
          </pre>
        </div>
        <p className="mt-3 text-center text-xs text-ink-muted">
          The same surface a human uses — 61 documented endpoints, OpenAPI, an <code className="font-mono">llms.txt</code> index, and scoped Bearer tokens.
        </p>
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 py-12 sm:grid-cols-3">
        <Wedge title="Agent-operable">
          Every action is a documented REST endpoint with a stable JSON shape. Scoped <code className="font-mono">resource:action</code> tokens,
          an OpenAPI spec, an <code className="font-mono">llms.txt</code> index, and a <code className="font-mono">nopm</code> CLI — so any agent drives it over plain HTTP.
        </Wedge>
        <Wedge title="Institutional governance">
          Every mutation writes exactly one append-only audit row. Destructive actions need four-eyes: a maker requests,
          a different checker approves. Enforced by Postgres triggers &amp; constraints — even a service key can&apos;t rewrite history.
        </Wedge>
        <Wedge title="The whole triangle">
          Timeline, resource and budget in one governed model — the gap most PM tools miss. Over-allocation surfaces as a
          clash; spend rolls up to variance and burn; a locked timeline forces a rebaseline sign-off.
        </Wedge>
      </section>

      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Built solo with an AI multi-agent workflow.</span>
          <span className="font-mono text-xs">stillnotbald.com</span>
        </div>
      </footer>
    </div>
  );
}
