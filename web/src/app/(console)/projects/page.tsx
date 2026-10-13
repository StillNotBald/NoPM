import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { ProjectsRegister, type ProjectRow } from "@/components/projects/projects-register";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";

export const metadata: Metadata = { title: "Projects" };

// Whitelists mirror GET /api/export?entity=projects (filters + sort fields).
const RAG = ["not_started", "green", "amber", "red", "complete"];
const PHASES = ["initiation", "planning", "execution", "monitoring", "closing"];
const SORT_FIELDS = ["name", "code", "rag_status", "phase", "completion_pct", "target_date"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs((await cookies()).get(APPEARANCE_COOKIE_NAME)?.value).dateDisplay;

  const sp = await searchParams;
  const q = one(sp.q)?.trim().slice(0, 100);
  const rag = one(sp.rag_status);
  const phase = one(sp.phase);
  const programId = one(sp.program_id);
  const [sortField, sortDir] = (one(sp.sort) ?? "").split(":");

  let query = db
    .from("projects")
    .select("id, code, name, rag_status, phase, completion_pct, target_date, is_locked, program");
  if (rag && RAG.includes(rag)) query = query.eq("rag_status", rag);
  if (phase && PHASES.includes(phase)) query = query.eq("phase", phase);
  if (programId && UUID.test(programId)) query = query.eq("program_id", programId);
  if (q) query = query.ilike("name", `%${q.replace(/[\\%_]/g, "\\$&")}%`);
  query =
    SORT_FIELDS.includes(sortField) && (sortDir === "asc" || sortDir === "desc")
      ? query.order(sortField, { ascending: sortDir === "asc" })
      : query.order("created_at", { ascending: false });

  const [{ data: projects, error }, { data: programs }, { data: profile }] = await Promise.all([
    query,
    db.from("programs").select("id, name").order("name"),
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);

  if (error) return <QueryError what="projects" message={error.message} />;

  return (
    <PageContainer>
      <ProjectsRegister
        rows={(projects ?? []) as ProjectRow[]}
        programs={(programs ?? []) as Array<{ id: string; name: string }>}
        dateDisplayPref={dateDisplayPref}
        canWrite={profile?.role !== "viewer"}
      />
    </PageContainer>
  );
}
