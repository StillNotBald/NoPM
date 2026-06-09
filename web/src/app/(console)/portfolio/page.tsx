import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import {
  PortfolioRoadmap,
  type PortfolioProject,
  type PortfolioMilestone,
} from "@/components/portfolio/roadmap";

export const metadata = { title: "Portfolio Roadmap — NoPM" };

export default async function PortfolioPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");

  // Parallel fetches — RLS automatically scopes to the user's workspace
  const [projectsResult, milestonesResult] = await Promise.all([
    db
      .from("projects")
      .select("id,code,name,rag_status,completion_pct,start_date,target_date")
      .order("code", { ascending: true }),
    db
      .from("milestones")
      .select(
        "project_id,name,target_date,baseline_target_date,status,completion_pct",
      )
      .order("target_date", { ascending: true, nullsFirst: false }),
  ]);

  const projects: PortfolioProject[] = (projectsResult.data ?? []) as PortfolioProject[];
  const milestones: PortfolioMilestone[] = (milestonesResult.data ?? []) as PortfolioMilestone[];

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader
        title="Portfolio Roadmap"
        action={
          <span className="font-mono text-xs text-ink-muted tabular-nums">
            {projects.length} project{projects.length !== 1 ? "s" : ""}
            {milestones.length > 0
              ? ` · ${milestones.length} milestone${milestones.length !== 1 ? "s" : ""}`
              : ""}
          </span>
        }
      />

      <PortfolioRoadmap projects={projects} milestones={milestones} />
    </div>
  );
}
