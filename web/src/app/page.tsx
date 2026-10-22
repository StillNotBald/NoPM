import Link from "next/link";
import type { Metadata } from "next";
import { DemoLoginButton } from "@/components/demo-login-button";
import { TerminalCard } from "@/components/ui/terminal-card";
import { ButtonLink, marketingNavLinkClass } from "@/components/marketing/button-link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MobileNavMenu } from "@/components/marketing/mobile-nav";
import { LANDING_DESCRIPTION, LANDING_TITLE, pageMetadata } from "@/components/marketing/page-metadata";
import { ProofTranscript } from "@/components/marketing/transcript";
import { WedgeGrid } from "@/components/marketing/wedges";
import { Wordmark } from "@/components/marketing/wordmark";
import metrics from "@/lib/metrics.gen.json";

export const metadata: Metadata = pageMetadata({
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  path: "/",
});

const CONTACT_URL =
  process.env.NEXT_PUBLIC_CONTACT_URL ?? "https://github.com/StillNotBald/NoPM/issues/new/choose";

export default function Landing() {
  return (
    <MarketingShell
      header={
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Wordmark />
          <nav aria-label="Primary" className="flex items-center gap-3 text-sm sm:gap-5">
            <Link href="/case-study" className={`hidden md:inline-flex ${marketingNavLinkClass}`}>Case study</Link>
            <a href={CONTACT_URL} className={`hidden md:inline-flex ${marketingNavLinkClass}`}>Raise a change request</a>
            <a href="/llms.txt" className={`hidden md:inline-flex ${marketingNavLinkClass}`}>Agent API</a>
            <a href="/api/openapi.json" className={`hidden md:inline-flex ${marketingNavLinkClass}`}>OpenAPI</a>
            {/* lg, not md: at 768-1023px the extra link plus the demo button overflow the header. */}
            <Link href="/login" className={`hidden lg:inline-flex ${marketingNavLinkClass}`}>Sign in</Link>
            {/* From sm up; on a phone the hero's own button is the one primary in view. */}
            <div className="hidden sm:block">
              <DemoLoginButton size="sm" />
            </div>
            <MobileNavMenu
              className="md:hidden"
              links={[
                { href: "/case-study", label: "Case study" },
                { href: CONTACT_URL, label: "Raise a change request" },
                { href: "/llms.txt", label: "Agent API" },
                { href: "/api/openapi.json", label: "OpenAPI" },
                { href: "/login", label: "Sign in" },
              ]}
            />
          </nav>
        </header>
      }
      footer={
        <footer className="border-t border-border-subtle">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between">
            <span>Built solo with an AI multi-agent workflow.</span>
            <div className="flex items-center gap-4">
              <a href={CONTACT_URL} className="flex min-h-[44px] items-center rounded-md hover:text-ink focus-ring">Raise a change request</a>
              <span className="flex min-h-[44px] items-center font-mono text-xs">stillnotbald.com</span>
            </div>
          </div>
        </footer>
      }
    >
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-14 pt-16 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {/* No entrance animation on the h1: it is the LCP element and must paint at once. */}
          <h1 className="font-display text-[clamp(1.9rem,7vw,2.25rem)] sm:text-5xl xl:text-6xl leading-[1.05] tracking-tight text-ink">
            Project governance your AI agent can operate.
          </h1>
          <p className="rise rise-1 mt-5 max-w-2xl text-lg leading-relaxed text-ink-secondary">
            A lite project-management tool your AI agent operates, with governance in the data layer: immutable
            audit, scoped tokens, four-eyes approval. It sits beside Jira, Slack and Teams, like the{" "}
            <code className="font-mono text-ink">aws</code> CLI for project governance.
          </p>
          <div className="rise rise-2 mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
            <DemoLoginButton block />
            <ButtonLink plain href="/llms.txt" variant="secondary" block>
              Read the agent API
            </ButtonLink>
            <ButtonLink href="/login" variant="link" className="justify-center sm:justify-start">
              Sign in →
            </ButtonLink>
          </div>
        </div>

        <div className="rise rise-1 min-w-0">
          <TerminalCard title="an agent drives NoPM">
            <ProofTranscript />
          </TerminalCard>
          <p className="mt-3 text-xs text-ink-muted">
            Humans and agents share one surface: {metrics.endpoints} documented endpoints, OpenAPI, <code className="font-mono">llms.txt</code>, scoped Bearer tokens.
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {metrics.deps} runtime dependencies, {metrics.cliDeps}-dependency CLI.
          </p>
        </div>
      </section>

      <section aria-labelledby="wedges-heading" className="mx-auto max-w-6xl px-6 py-12">
        <h2 id="wedges-heading" className="mb-6 text-xl font-semibold text-ink">
          Three things most PM tools can&apos;t claim together.
        </h2>
        <WedgeGrid />
      </section>
    </MarketingShell>
  );
}
