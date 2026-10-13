import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { TaskList, type ProjectTask } from "@/components/my-tasks/task-list";

export const metadata = { title: "My Tasks" };

export default async function MyTasksPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const userId = user.id;

  // Bridge login → resource_member(s): tasks are assigned to a resource_member,
  // which links to a login via resource_members.profile_id.
  const { data: myMembers } = await db
    .from("resource_members")
    .select("id")
    .eq("profile_id", userId);
  const myMemberIds = (myMembers ?? []).map((m) => m.id);

  // Fetch all open tasks assigned to me (any of my resource_member ids), joined to their project
  const { data: rows, error } = myMemberIds.length
    ? await db
        .from("tasks")
        .select(
          "id, name, status, status_type, priority, due_date, project_id, projects(id, code, name, rag_status)",
        )
        .in("assignee_id", myMemberIds)
        .not("status_type", "in", '("completed","canceled")')
        .order("due_date", { ascending: true, nullsFirst: false })
    : { data: [], error: null };

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <p className="text-sm text-danger">Failed to load tasks: {error.message}</p>
      </div>
    );
  }

  // Flatten joined shape into a flat ProjectTask
  const tasks: ProjectTask[] = (rows ?? []).map((row) => {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      status_type: row.status_type,
      priority: row.priority ?? null,
      due_date: row.due_date ?? null,
      project_id: row.project_id,
      project_code: project?.code ?? null,
      project_name: project?.name ?? "Unknown project",
      project_rag_status: project?.rag_status ?? null,
    };
  });

  const openCount = tasks.length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader
        title="My Tasks"
        action={
          openCount > 0 ? (
            <span className="rounded-full bg-sunken px-2.5 py-1 font-mono text-xs text-ink-muted">
              {openCount} open
            </span>
          ) : undefined
        }
      />

      <TaskList tasks={tasks} />
    </div>
  );
}
