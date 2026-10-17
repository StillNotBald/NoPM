import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { ClashFocusOpener } from "./_clash-focus-opener";
import { ClashesView } from "./_clashes-view";
import type { ClashRow } from "./_types";

export const metadata: Metadata = { title: "Clashes" };

type SP = Record<string, string | string[] | undefined>;

const TYPES = new Set(["schedule", "resource", "dependency"]);
const STATUSES = new Set(["open", "investigating", "resolved"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

export default async function ClashesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Whitelisted URL filters (written by the register toolbar); RLS scopes to the workspace.
  const type = first(sp.type);
  const status = first(sp.status);
  const projectId = first(sp.project_id);

  let clashQuery = db
    .from("clashes")
    .select(
      "id, reference_id, title, type, severity, project_a_id, project_b_id, status, description, over_allocation_pct, recommended_action",
    )
    .order("created_at", { ascending: false });
  if (type && TYPES.has(type)) clashQuery = clashQuery.eq("type", type);
  if (status && STATUSES.has(status)) clashQuery = clashQuery.eq("status", status);
  // A clash spans two projects — match either side. UUID-validated before interpolation.
  if (projectId && UUID.test(projectId)) {
    clashQuery = clashQuery.or(`project_a_id.eq.${projectId},project_b_id.eq.${projectId}`);
  }

  const [{ data: clashes, error: clashError }, { data: projects, error: projectsError }] = await Promise.all([
    clashQuery,
    db.from("projects").select("id, name").order("name"),
  ]);

  if (clashError) return <QueryError what="clashes" message={clashError.message} />;
  if (projectsError) return <QueryError what="projects" message={projectsError.message} />;

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));
  const clashList = (clashes ?? []) as ClashRow[];

  return (
    <PageContainer width="wide" className="space-y-5">
      {/* Deep-link auto-open: ?clash=<id> scrolls to and highlights the matching row */}
      <Suspense fallback={null}>
        <ClashFocusOpener clashes={clashList} projectMap={projectMap} />
      </Suspense>

      <ClashesView clashes={clashList} projects={projects ?? []} projectMap={projectMap} />
    </PageContainer>
  );
}
