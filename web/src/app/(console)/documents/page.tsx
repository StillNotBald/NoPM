import { redirect } from "next/navigation";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { DocumentsClient, NewDocumentButton } from "@/components/documents/documents-client";

export const metadata = { title: "Documents" };

export default async function DocumentsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: documents }, { data: projects }, { data: members }, { data: viewerProfile }] =
    await Promise.all([
      db
        .from("documents")
        .select(
          "id, workspace_id, project_id, reference_id, folder, title, doc_type, status, version, summary, body, external_url, owner_id, created_by, created_at, updated_at",
        )
        .order("updated_at", { ascending: false }),
      db.from("projects").select("id, name").order("name"),
      db.from("profiles").select("id, display_name, email"),
      // caller's own role — see risks/page.tsx for the pattern (L-46).
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    ]);
  const canWrite = viewerProfile?.role !== "viewer";
  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  const projectMap = Object.fromEntries(
    (projects ?? []).map((p) => [p.id, p.name]),
  );

  const ownerMap: Record<string, string> = {};
  for (const m of members ?? []) {
    ownerMap[m.id] =
      m.display_name ?? m.email ?? m.id.slice(0, 8) + "…";
  }

  return (
    <PageContainer width="wide" className="space-y-6">
      <PageHeader
        title="Documents"
        action={<NewDocumentButton projects={projects ?? []} />}
      />

      <Card className="overflow-hidden">
        {/* Suspense boundary required by useSearchParams inside DocumentsClient */}
        <Suspense>
          <DocumentsClient
            documents={documents ?? []}
            projects={projects ?? []}
            projectMap={projectMap}
            ownerMap={ownerMap}
            canWrite={canWrite}
            dateDisplayPref={dateDisplayPref}
          />
        </Suspense>
      </Card>
    </PageContainer>
  );
}
