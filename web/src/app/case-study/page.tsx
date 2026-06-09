import Link from "next/link";
import { DownloadOnePagerButton } from "@/components/case-study/download-button";

export const metadata = {
  title: "Case Study — NoPM",
  description:
    "How a solo PMP Tech PMO built an AI-native, governance-grade lite PM tool as a live portfolio artifact — immutable audit, scoped PATs, maker-checker approval, BYOK assistant, and 39 traced requirements shipped in eight waves.",
};

// ─── shared primitives ────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-accent">
      {children}
    </p>
  );
}

function Rule() {
  return <hr className="border-border-subtle" />;
}

function Wedge({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-sunken p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{children}</p>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border-subtle bg-sunken px-5 py-4 text-center">
      <span className="font-mono text-2xl font-bold text-accent">{value}</span>
      <span className="mt-1 text-xs text-ink-muted">{label}</span>
    </div>
  );
}

function ModuleRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-ink-secondary">
      <span className="mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      {children}
    </li>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function CaseStudyPage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">

      {/* ── nav ── */}
      <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-sm font-semibold text-white">
              N
            </span>
            <span className="font-medium">NoPM</span>
          </Link>
        </div>
        <nav className="flex items-center gap-4 text-sm text-ink-secondary">
          <Link href="/" className="hover:text-ink">Home</Link>
          <Link href="/login" className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover">
            Open console
          </Link>
        </nav>
      </header>

      {/* ── hero ── */}
      <section className="mx-auto max-w-4xl px-6 pb-10 pt-12">
        <SectionLabel>Portfolio case study</SectionLabel>
        <h1 className="mt-3 max-w-3xl font-serif text-4xl leading-[1.1] text-ink">
          I build the systems that make unclear requirements impossible.
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-secondary">
          NoPM is a live, hosted proof-piece for that thesis. It is a lite,
          API-first project management tool where governance — immutable audit,
          scoped tokens, four-eyes approval — is{" "}
          <em>engineered into the data and API layer</em>, not bolted onto the UI.
          Shipped solo in eight waves using an AI multi-agent workflow.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Open the live console →
          </Link>
          <DownloadOnePagerButton />
          <a
            href="https://stillnotbald.com"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-ink-muted hover:text-ink"
          >
            stillnotbald.com
          </a>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── the thesis ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>The thesis</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Governance belongs in the data layer.
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          Most PM tools treat audit trails and change control as UI features —
          export logs, activity feeds, manual history. They can be bypassed by
          anyone with a database connection or a sufficiently permissive service
          key.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          NoPM inverts that. Every mutation flows through the{" "}
          <code className="font-mono text-ink">route()</code> API wrapper and
          calls{" "}
          <code className="font-mono text-ink">writeAudit()</code> exactly once —
          fail-closed. Postgres triggers enforce append-only semantics. A service
          key cannot rewrite history. The UI is just a consumer of the same
          governed API your agent calls.
        </p>
        <blockquote className="mt-6 border-l-2 border-accent pl-4">
          <p className="text-sm leading-relaxed text-ink-secondary italic">
            &ldquo;The same surface a human uses — 33 documented endpoints, OpenAPI,
            an <code className="font-mono">llms.txt</code> index, and scoped
            Bearer tokens — is the surface an AI agent uses. No special mode,
            no privileged bypass.&rdquo;
          </p>
        </blockquote>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── the wedge ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>The wedge</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Three properties most PM tools can&apos;t claim simultaneously.
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Wedge title="AI-native / agent-operable">
            Every action is a stable REST endpoint. Scoped{" "}
            <code className="font-mono text-xs">resource:action</code> Bearer
            tokens, an OpenAPI spec, an{" "}
            <code className="font-mono text-xs">llms.txt</code> discovery index,
            and a <code className="font-mono text-xs">nopm</code> CLI let any
            agent drive the tool over plain HTTP — identical to the web console.
          </Wedge>
          <Wedge title="Institutional governance">
            Every mutation writes exactly one append-only audit row. Destructive
            deletes need four-eyes: a maker requests, a{" "}
            <em>different</em> checker approves (enforced by Postgres{" "}
            <code className="font-mono text-xs">CHECK</code> constraints). Even
            a service key can&apos;t rewrite history.
          </Wedge>
          <Wedge title="The whole triangle">
            Timeline, resource, and budget in one governed model — the gap most
            lite PM tools miss. Over-allocation surfaces as a clash; spend rolls
            up to EVM variance; a locked timeline forces a rebaseline sign-off.
          </Wedge>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── what was built ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>What was built</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          8 modules + governed infrastructure — shipped solo in 8 waves.
        </h2>

        {/* terminal card */}
        <div className="mt-6 overflow-hidden rounded-xl border border-border-subtle bg-[#0e0e0f]">
          <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" aria-hidden />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" aria-hidden />
            <span className="ml-3 font-mono text-xs text-white/40">
              governance is invisible to the operator — provable in audit
            </span>
          </div>
          <pre className="overflow-x-auto px-5 py-4 font-mono text-[12px] leading-relaxed text-white/80">
{`$ nopm tasks rm task_8f3a --reason "superseded by revised cutover plan"
⏸  delete requested — pending a checker's approval (four-eyes)

$ nopm approve req_2c91          # a different token: task:delete:approve
✓  approved & committed           # one immutable audit row written

$ nopm audit --limit 1
created_at            actor_label     action        target
2026-06-08T…          checker (agent) task.delete   task_8f3a`}
          </pre>
        </div>

        <div className="mt-8 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <ul className="space-y-2">
            <ModuleRow>
              Workspace → Project → Milestone → Task (typed statuses, maker-checker delete)
            </ModuleRow>
            <ModuleRow>
              Risk &amp; Issue registers with severity/likelihood scoring
            </ModuleRow>
            <ModuleRow>
              Clash engine — schedule, resource, and dependency conflicts (cross-project)
            </ModuleRow>
            <ModuleRow>
              Resource, allocation, timesheets, cost-rate, and capacity
            </ModuleRow>
            <ModuleRow>
              Budget: planned / committed / actual / EVM (CPI, SPI, EAC, VAC)
            </ModuleRow>
          </ul>
          <ul className="space-y-2">
            <ModuleRow>
              Governed Kanban (drag = audited mutation) + read-mostly Gantt with rebaseline gate
            </ModuleRow>
            <ModuleRow>
              Trust Center — immutable audit stream, provenance, PAT management
            </ModuleRow>
            <ModuleRow>
              BYOK governed assistant (user&apos;s own API key, AES-256-GCM at rest,
              ephemeral scoped token — NoPM ships no model key)
            </ModuleRow>
            <ModuleRow>
              Documents &amp; charter management with versioning and status workflow
            </ModuleRow>
            <ModuleRow>
              Change-control pipeline, notifications, deck export (PDF / PPTX / HTML)
            </ModuleRow>
          </ul>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── proof metrics ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>Proof metrics</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Numbers that show the governance isn&apos;t hand-waving.
        </h2>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Metric value="39" label="traced requirements (R-IDs) in RTM" />
          <Metric value="100+" label="governance-focused tests (vitest)" />
          <Metric value="33" label="documented REST endpoints + OpenAPI" />
          <Metric value="1" label="immutable audit row per mutation — no exceptions" />
          <Metric value="0" label="bundled LLM — governance ships without any model key" />
        </div>
        <p className="mt-6 text-sm leading-relaxed text-ink-muted">
          Every requirement has an R-ID, a status, and a traceability row. RTM
          verification runs in CI. Tests target the governance rules first: can a
          maker self-approve? Does a missing scope return 403? Does a delete
          without a four-eyes approval fail?
        </p>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── stack & method ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>Stack &amp; method</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Production stack, shipped with AI multi-agent assist.
        </h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Technology
            </p>
            <ul className="space-y-1.5 text-sm text-ink-secondary">
              <li>
                <span className="font-mono text-xs text-ink">Next.js 16</span>{" "}
                App Router + TypeScript + Tailwind v4
              </li>
              <li>
                <span className="font-mono text-xs text-ink">Supabase</span>{" "}
                — Postgres + RLS + Auth + Storage
              </li>
              <li>
                <span className="font-mono text-xs text-ink">Vercel</span>{" "}
                deploy + Cloudflare DNS → stillnotbald.com
              </li>
              <li>
                <span className="font-mono text-xs text-ink">jsPDF / pptxgenjs</span>{" "}
                — governed deck exports
              </li>
              <li>
                <span className="font-mono text-xs text-ink">vitest</span>{" "}
                — 100+ tests, governance-first coverage
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Discipline
            </p>
            <ul className="space-y-1.5 text-sm text-ink-secondary">
              <li>
                Requirement traceability matrix (RTM) — R-ID per feature,
                verified in CI
              </li>
              <li>
                Sprint log per wave — plan, decisions, and a signed-off summary
              </li>
              <li>
                Architecture decision records (ADRs) for irreversible choices
              </li>
              <li>
                AI multi-agent workflow — sub-agents per domain, orchestrated
                by a wave planner
              </li>
              <li>
                Solo build — no team, no PM, no sprint ceremonies
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── call to action ── */}
      <section className="mx-auto max-w-4xl px-6 py-12 text-center">
        <h2 className="text-xl font-semibold text-ink">
          See the governance live.
        </h2>
        <p className="mt-2 text-sm text-ink-secondary">
          Every endpoint is documented. Every mutation is audited. The console is
          open.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Open the live console →
          </Link>
          <a
            href="/api/openapi.json"
            className="rounded-md border border-border-strong px-5 py-2.5 text-sm font-medium text-ink hover:bg-sunken"
          >
            OpenAPI spec
          </a>
          <a
            href="/llms.txt"
            className="rounded-md border border-border-strong px-5 py-2.5 text-sm font-medium text-ink hover:bg-sunken"
          >
            Agent API (llms.txt)
          </a>
          <DownloadOnePagerButton />
        </div>
      </section>

      {/* ── footer ── */}
      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <span>
            Built solo with an AI multi-agent workflow.
          </span>
          <span className="font-mono text-xs">stillnotbald.com</span>
        </div>
      </footer>
    </div>
  );
}
