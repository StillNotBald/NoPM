import { redirect } from "next/navigation";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewIssueButton } from "@/components/registers/new-issue-form";
import { IssueDataList } from "@/components/registers/issue-detail";
import { IssueFocusOpener } from "@/components/registers/issue-focus-opener";
import { EmptyState } from "@/components/ui/empty-state";

export default async function IssuesPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  const [{ data: issues }, { data: projects }, { data: viewerProfile }] = await Promise.all([
    db
      .from("issues")
      .select(
        "id, reference_id, title, description, project_id, priority, status, due_date, resolution, raised_at, severity, issue_category, impact, resolution_eta, resolved_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
    // caller's own role — see risks/page.tsx for the pattern (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const canWrite = viewerProfile?.role !== "viewer";

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Issue Register"
        action={<NewIssueButton projects={projects ?? []} />}
      />

      {/* Deep-link auto-opener — opens inspector for ?issue=<id> */}
      <Suspense>
        <IssueFocusOpener
          issues={issues ?? []}
          projectMap={projectMap}
        />
      </Suspense>

      {/* List — table ≥md, cards <md (F5) */}
      <Card>
        {issues && issues.length > 0 ? (
          <IssueDataList issues={issues} projectMap={projectMap} dateDisplayPref={dateDisplayPref} />
        ) : (
          <EmptyState
            purpose="The issue register tracks problems that have already happened — what broke, who owns the fix, and when it resolved."
            canWrite={canWrite}
            action={<NewIssueButton projects={projects ?? []} />}
            docsHref="/trust"
            docsLabel="See governance in the Trust Center"
          />
        )}
      </Card>
      </div>
    </div>
  );
}
