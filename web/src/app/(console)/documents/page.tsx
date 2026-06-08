import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DocumentsClient, NewDocumentButton } from "@/components/documents/documents-client";

export default async function DocumentsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: documents }, { data: projects }, { data: members }] =
    await Promise.all([
      db
        .from("documents")
        .select(
          "id, workspace_id, project_id, reference_id, folder, title, doc_type, status, version, summary, body, external_url, owner_id, created_by, created_at, updated_at",
        )
        .order("updated_at", { ascending: false }),
      db.from("projects").select("id, name").order("name"),
      db.from("profiles").select("id, display_name, email"),
    ]);

  const projectMap = Object.fromEntries(
    (projects ?? []).map((p) => [p.id, p.name]),
  );

  const ownerMap: Record<string, string> = {};
  for (const m of members ?? []) {
    ownerMap[m.id] =
      m.display_name ?? m.email ?? m.id.slice(0, 8) + "…";
  }

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
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
            />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}
