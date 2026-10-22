import Link from "next/link";
import type { Metadata } from "next";
import { DownloadOnePagerButton } from "@/components/case-study/download-button";
import { DemoLoginButton } from "@/components/demo-login-button";
import { TerminalCard } from "@/components/ui/terminal-card";
import { ButtonLink, marketingNavLinkClass } from "@/components/marketing/button-link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MobileNavMenu } from "@/components/marketing/mobile-nav";
import { pageMetadata } from "@/components/marketing/page-metadata";
import { ProofTranscript } from "@/components/marketing/transcript";
import { WedgeGrid } from "@/components/marketing/wedges";
import { Wordmark } from "@/components/marketing/wordmark";
import metrics from "@/lib/metrics.gen.json";

export const metadata: Metadata = pageMetadata({
  title: "Case study — NoPM",
  description:
    `How a solo PMP Tech PMO built an AI-native, governance-grade lite PM tool as a live portfolio artifact — immutable audit, scoped PATs, four-eyes approval, BYOK assistant, and ${metrics.rids} traced requirements shipped in eight waves.`,
  path: "/case-study",
});

// ─── shared primitives ────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-widest text-accent">
      {children}
    </p>
  );
}

function Rule() {
  return <hr aria-hidden="true" className="border-border-subtle" />;
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border-subtle bg-well px-5 py-4 text-center">
      <span className="font-mono text-2xl font-bold text-accent">{value}</span>
      <span className="mt-1 text-xs text-ink-muted">{label}</span>
    </div>
  );
}

function ModuleRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-ink-secondary">
      <span aria-hidden="true" className="mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ink-muted" />
      {children}
    </li>
  );
}

// The 2026-09-06 review, as re-run. Rendered as a table from `sm` up and as
// stacked finding/state pairs below it (the table needed a 640px scroller whose
// answers column started off-screen on a phone).
const CLOSED_DEFECTS: ReadonlyArray<readonly [string, string]> = [
  ["Eleven mutating routes wrote no audit row, including BYOK key set and delete.", "Closed. A coverage test fails the build on any unaudited write. The key lifecycle is audited without the key."],
  ["Ordinary writes persist before the audit row; only two flows are transactional.", "Open by decision. The Trust Center says so."],
  ["One scope both raised and decided change requests. A token requester made the DB check vacuous.", "Closed. change:decide is a separate scope agents never hold. Requester and decider are typed identities, checked in the API and the database."],
  ["Unlocking a frozen baseline needed no reason.", "Partly closed. A reason is required in the API, dialog and CLI. The same person can still unlock."],
  ["Audit rows had no client origin or request id.", "Partly closed. Every row records the declared client and a request id, including rows written inside database functions. No hash chain yet."],
  ["No record could point at a Jira key or Slack thread.", "Closed. Tasks, projects, risks, issues and decisions carry source, external_ref and external_url."],
  ["No public page said NoPM complements Jira, Slack or Teams.", "Closed. README, landing, this page and the product doc say it."],
  ["Lock and rebaseline had no navigation home.", "Closed. Baselines lives under Governance. The demo page moved to My Work."],
  ["The audit immutability triggers had no regression test.", "Closed. A migration-text test fails if any migration drops, disables or bypasses them."],
  ["Tool and metric counts drifted between surfaces.", "Closed. Counts are generated and CI-checked."],
];

function ClosedDefects() {
  return (
    <>
      <ul className="mt-6 divide-y divide-border-subtle rounded-md border border-border-subtle sm:hidden">
        {CLOSED_DEFECTS.map(([before, after]) => (
          <li key={before} className="px-4 py-3 text-sm">
            <dl className="space-y-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">Finding (morning)</dt>
                <dd className="mt-0.5 text-ink-secondary">{before}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">State (evening)</dt>
                <dd className="mt-0.5 text-ink">{after}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <div className="mt-6 hidden overflow-x-auto rounded-md border border-border-subtle sm:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-well text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Finding (morning)</th>
              <th scope="col" className="px-4 py-2 font-medium">State (evening)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle text-ink-secondary">
            {CLOSED_DEFECTS.map(([before, after]) => (
              <tr key={before}>
                <td className="px-4 py-2.5 align-top">{before}</td>
                <td className="px-4 py-2.5 align-top text-ink">{after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export default function CaseStudyPage() {
  return (
    <MarketingShell
      header={
        <header className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Wordmark />
          <nav aria-label="Primary" className="flex items-center gap-3 text-sm sm:gap-4">
            <Link href="/" className={`hidden md:inline-flex ${marketingNavLinkClass}`}>Home</Link>
            <Link href="/login" className={`hidden md:inline-flex ${marketingNavLinkClass}`}>Sign in</Link>
            {/* From sm up; on a phone the hero's own button is the one primary in view. */}
            <div className="hidden sm:block">
              <DemoLoginButton size="sm" />
            </div>
            <MobileNavMenu
              className="md:hidden"
              links={[
                { href: "/", label: "Home" },
                { href: "/login", label: "Sign in" },
              ]}
            />
          </nav>
        </header>
      }
      footer={
        <footer className="border-t border-border-subtle">
          <div className="mx-auto flex max-w-4xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
            <span>
              Built solo with an AI multi-agent workflow.
            </span>
            <span className="font-mono text-xs">stillnotbald.com</span>
          </div>
        </footer>
      }
    >
      {/* ── hero ── */}
      <section className="mx-auto max-w-4xl px-6 pb-10 pt-12">
        <div className="rise">
          <SectionLabel>Portfolio case study</SectionLabel>
        </div>
        {/* No entrance animation on the h1: it is the LCP element and must paint at once. */}
        <h1 className="mt-3 font-display text-3xl sm:text-5xl leading-[1.05] tracking-tight text-ink">
          I build the systems that make unclear requirements impossible.
        </h1>
        <p className="rise rise-2 mt-4 max-w-2xl text-base leading-relaxed text-ink-secondary">
          NoPM is a lite, API-first project management tool with governance
          (immutable audit, scoped tokens, four-eyes approval){" "}
          <em>built into the data and API layer</em>, not the UI. Built solo
          in eight waves with AI agents.
        </p>
        <div className="rise rise-3 mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <DemoLoginButton block />
          <ButtonLink href="/login" variant="link" className="justify-center sm:justify-start">
            Sign in →
          </ButtonLink>
          <DownloadOnePagerButton />
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
          Most PM tools make audit a UI feature, so anyone with database access
          can bypass it.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          In NoPM every mutation goes through the{" "}
          <code className="font-mono text-ink">route()</code> wrapper and calls{" "}
          <code className="font-mono text-ink">writeAudit()</code> exactly once,
          fail-closed. Postgres triggers keep the log append-only, so even a
          service key cannot rewrite history. The UI uses the same governed API
          your agent does.
        </p>
        {/* A sunken well, not a coloured left rule: DESIGN.md rejects border-left accents. */}
        <blockquote className="mt-6 max-w-2xl rounded-lg border border-border-subtle bg-well px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-secondary italic">
            &ldquo;Humans and agents use the same surface: {metrics.endpoints} documented endpoints, OpenAPI,
            an <code className="font-mono">llms.txt</code> index and scoped
            Bearer tokens. No special mode, no bypass.&rdquo;
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
          Three things most PM tools can&apos;t claim together.
        </h2>
        <div className="mt-6">
          <WedgeGrid />
        </div>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── what was built ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>What was built</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          A governance spine and the registers it needs.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
          NoPM is the governed record beside Jira, Slack and Teams, not a replacement.
        </p>

        {/* terminal card */}
        <TerminalCard
          className="mt-6"
          title="governance is invisible to the operator — provable in audit"
        >
          <ProofTranscript />
        </TerminalCard>

        <div className="mt-8 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          <ul className="space-y-2">
            <ModuleRow>
              Governed Kanban (drag = audited) and Gantt with rebaseline gate
            </ModuleRow>
            <ModuleRow>
              Trust Center: immutable audit log, provenance, tokens
            </ModuleRow>
            <ModuleRow>
              Change control, notifications, deck export (PDF / PPTX / HTML)
            </ModuleRow>
            <ModuleRow>
              Link invites: role-capped, revocable, audited
            </ModuleRow>
            <ModuleRow>
              Workspace, Project, Milestone, Task (maker-checker delete)
            </ModuleRow>
            <ModuleRow>
              Risk and Issue registers with scoring
            </ModuleRow>
          </ul>
          <ul className="space-y-2">
            <ModuleRow>
              Clashes: schedule, resource and dependency conflicts
            </ModuleRow>
            <ModuleRow>
              Resources, allocation, cost rate, capacity
            </ModuleRow>
            <ModuleRow>
              Budget: planned / committed / actual / EVM (CPI, SPI, EAC, VAC)
            </ModuleRow>
            <ModuleRow>
              Sprints: burndown and velocity
            </ModuleRow>
            <ModuleRow>
              BYOK assistant (your own API key, AES-256-GCM at rest, ephemeral
              scoped token). NoPM ships no model.
            </ModuleRow>
            <ModuleRow>
              Versioned documents and charters
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
          Numbers behind the governance.
        </h2>
        {/* Every numeral here is read from metrics.gen.json; nothing is typed in. */}
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Metric value={String(metrics.rids)} label="traced requirements (R-IDs) in RTM" />
          <Metric value={String(metrics.tests)} label="governance-focused tests (vitest)" />
          <Metric value={String(metrics.endpoints)} label="documented REST endpoints + OpenAPI" />
        </div>
        <p className="mt-6 text-sm leading-relaxed text-ink-muted">
          These counts are generated from the RTM, the test run and the API
          route tree. CI fails if they drift. Tests target governance first:
          can a maker self-approve? Does a missing scope return 403? Does a
          delete without four-eyes approval fail?
        </p>
        <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Invariants (stated, not counted)
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-ink-secondary">
          <li>One immutable audit row per mutation.</li>
          <li>No bundled LLM. No model key ships.</li>
        </ul>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── reviewed, then closed ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>Reviewed, then closed</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Ten defects confirmed by review. Two sprints later.
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-secondary">
          On 2026-09-06 a six-lens review tested the code and a verifier
          confirmed ten defects. Two sprints closed or narrowed them the same
          day. Below is the re-run, not the plan.
        </p>
        <ClosedDefects />
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          Review, sprint receipts and re-run are in the repo under{" "}
          <code className="font-mono">docs/research</code> and{" "}
          <code className="font-mono">sprint-log</code>.
        </p>
      </section>

      <div className="mx-auto max-w-4xl px-6">
        <Rule />
      </div>

      {/* ── stack & method ── */}
      <section className="mx-auto max-w-4xl px-6 py-10">
        <SectionLabel>Stack &amp; method</SectionLabel>
        <h2 className="mt-3 text-xl font-semibold text-ink">
          Production stack, built with AI agents.
        </h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Technology
            </p>
            <ul className="space-y-1.5 text-sm text-ink-secondary">
              <li>
                <span className="font-mono text-xs text-ink">Next.js 16</span>{" "}
                App Router, TypeScript, Tailwind v4
              </li>
              <li>
                <span className="font-mono text-xs text-ink">Supabase</span>{" "}
                Postgres, RLS, Auth, Storage
              </li>
              <li>
                <span className="font-mono text-xs text-ink">Vercel</span>{" "}
                deploy, Cloudflare DNS
              </li>
              <li>
                <span className="font-mono text-xs text-ink">jsPDF / pptxgenjs</span>{" "}
                deck exports
              </li>
              <li>
                <span className="font-mono text-xs text-ink">vitest</span>{" "}
                {metrics.tests} tests, governance first
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Discipline
            </p>
            <ul className="space-y-1.5 text-sm text-ink-secondary">
              <li>
                Requirement traceability matrix (RTM), checked in CI
              </li>
              <li>
                Sprint log per wave
              </li>
              <li>
                Architecture decision records (ADRs)
              </li>
              <li>
                AI multi-agent workflow
              </li>
              <li>
                Solo build
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
          Every endpoint is documented. Every mutation is audited.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
          <DemoLoginButton block />
          <ButtonLink href="/login" variant="secondary" block>
            Sign in →
          </ButtonLink>
          <ButtonLink plain href="/api/openapi.json" variant="secondary" block>
            OpenAPI spec
          </ButtonLink>
          <ButtonLink plain href="/llms.txt" variant="secondary" block>
            Agent API (llms.txt)
          </ButtonLink>
          <DownloadOnePagerButton />
        </div>
      </section>
    </MarketingShell>
  );
}
