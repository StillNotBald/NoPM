import Link from "next/link";
import { DemoLoginButton } from "@/components/demo-login-button";
import { TerminalCard } from "@/components/ui/terminal-card";
import { WedgeGrid } from "@/components/marketing/wedges";
import metrics from "@/lib/metrics.gen.json";

export const metadata = {
  title: "NoPM — project governance your AI agent can operate",
  description:
    "A lite, API-first project-management tool your AI agent drives like the aws/supabase CLIs. Immutable audit, scoped tokens, four-eyes approval — enforced in the data layer.",
};

export default function Landing() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
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

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-14 pt-16 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <h1 className="rise font-display text-4xl sm:text-5xl xl:text-6xl leading-[1.05] tracking-tight text-ink">
            Project governance your AI agent can operate.
          </h1>
          <p className="rise rise-1 mt-5 max-w-2xl text-lg leading-relaxed text-ink-secondary">
            A lite, API-first PM tool your own agent drives — like the <code className="font-mono text-ink">aws</code> or{" "}
            <code className="font-mono text-ink">supabase</code> CLIs, but for project governance. Immutable audit,
            scoped tokens, and four-eyes approval are enforced in the data layer, not bolted onto the UI.
            It sits beside the tools you already run, Jira, Slack, Teams, and adds what they do not enforce:
            an immutable audit trail, change control, and four-eyes approval.
          </p>
          <div className="rise rise-2 mt-8 flex flex-wrap items-center gap-4">
            <DemoLoginButton />
            <a href="/llms.txt" className="rounded-md border border-border-strong px-5 py-2.5 font-medium text-ink hover:bg-sunken">
              Read the agent API
            </a>
            <Link href="/login" className="text-sm font-medium text-ink-secondary hover:text-ink">
              Sign in →
            </Link>
          </div>
        </div>

        <div className="rise rise-1">
          <TerminalCard title="an agent drives NoPM">
            <pre className="overflow-x-auto px-5 py-5 font-mono text-[13px] leading-relaxed text-white/80">
{`$ nopm tasks rm task_8f3a \\
    --reason "superseded by revised cutover plan"
⏸ delete requested — pending a checker's
  approval (four-eyes)

$ nopm approve req_2c91
✓ approved & committed
  # a different token: task:delete:approve
  # one immutable audit row written

$ nopm audit --limit 1
created_at   actor_label      action       target
2026-06-08T… checker (agent)  task.delete  task_8f3a`}
            </pre>
          </TerminalCard>
          <p className="mt-3 text-xs text-ink-muted">
            The same surface a human uses: {metrics.endpoints} documented endpoints, OpenAPI, <code className="font-mono">llms.txt</code>, scoped Bearer tokens.
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {metrics.deps} runtime dependencies, {metrics.cliDeps}-dependency CLI.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <WedgeGrid />
      </section>

      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <span>Built solo with an AI multi-agent workflow.</span>
          <span className="font-mono text-xs">stillnotbald.com</span>
        </div>
      </footer>
    </div>
  );
}
