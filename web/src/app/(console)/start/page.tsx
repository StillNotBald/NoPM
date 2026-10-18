import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { FolderKanban, ShieldCheck, Bot } from "lucide-react";
import { StartChecklist } from "@/components/onboarding/start-checklist";
import { QuickstartSnippet } from "@/components/onboarding/quickstart-snippet";
import { readOnboardingSeed } from "@/lib/onboarding/seed-server";
import { docUrlFor } from "@/lib/onboarding/hints";

/**
 * /start — Getting started (R-78). A data-driven checklist replacing "10
 * decisions before you've done anything useful" with 5 concrete steps and a
 * copy-paste quickstart. Owns no onboarding surface stacking: /dashboard
 * keeps the first-run wizard + governance tour, this page is the deliberate
 * "come back here anytime" destination (reachable from the command palette
 * and account menu — see components/command-palette.tsx / account-menu.tsx).
 *
 * All workspace counts are fetched here, server-side, in one Promise.all;
 * the checklist's `visited`/`dismissed` bookkeeping is client-side
 * (usePreferences) since it's per-viewer, not workspace data.
 */
export const metadata = { title: "Getting started" };

export default async function StartPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [
    projectsCountResult,
    tasksCountResult,
    auditCountResult,
    tokensCountResult,
    membersCountResult,
    viewerProfileResult,
    firstProjectResult,
    onboardingSeed,
  ] = await Promise.all([
    db.from("projects").select("id", { count: "exact", head: true }),
    db.from("tasks").select("id", { count: "exact", head: true }),
    db.from("audit_log").select("id", { count: "exact", head: true }),
    db.from("api_tokens").select("id", { count: "exact", head: true }).eq("revoked", false),
    db.from("profiles").select("id", { count: "exact", head: true }),
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("projects").select("id").order("created_at", { ascending: true }).limit(1),
    // whether the checklist is dismissed / which steps were visited, read on the
    // server so the card is in the first paint (React-cache()d, no extra query)
    readOnboardingSeed(),
  ]);

  const role = viewerProfileResult.data?.role ?? "member";
  const firstProjectId = firstProjectResult.data?.[0]?.id;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader title="Getting started" />

      {/* How NoPM works — 3-tile strip, 2 lines max each */}
      <div className="grid gap-4 sm:grid-cols-3">
        <HowItWorksTile
          icon={<FolderKanban size={16} />}
          title="Projects → Tasks"
          caption="Work lives under a project. Tasks move through a governed board."
        />
        <HowItWorksTile
          icon={<ShieldCheck size={16} />}
          title="Every change is audited"
          caption="Writes — including a board drag — produce one immutable audit row."
        />
        <HowItWorksTile
          icon={<Bot size={16} />}
          title="Your agent drives it"
          caption="A scoped token lets your own AI agent call the same REST API you do."
        />
      </div>

      <StartChecklist
        projects={projectsCountResult.count ?? 0}
        tasks={tasksCountResult.count ?? 0}
        auditRows={auditCountResult.count ?? 0}
        tokens={tokensCountResult.count ?? 0}
        members={membersCountResult.count ?? 0}
        role={role}
        firstProjectHref={firstProjectId ? `/projects/${firstProjectId}` : undefined}
        seed={onboardingSeed}
      />

      <Card>
        <CardHeader>
          <CardTitle>Quickstart from your terminal</CardTitle>
        </CardHeader>
        <CardBody>
          <QuickstartSnippet />
        </CardBody>
      </Card>

      <p className="px-1 text-xs text-ink-muted">
        A narrative walkthrough of these same five steps:{" "}
        <a
          href={docUrlFor("/user-manual/operator/00-first-ten-minutes.md")}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[11px] text-accent hover:underline"
        >
          user-manual/operator/00-first-ten-minutes.md
        </a>
      </p>
    </div>
  );
}

function HowItWorksTile({
  icon,
  title,
  caption,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-accent">{icon}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{caption}</p>
    </div>
  );
}
