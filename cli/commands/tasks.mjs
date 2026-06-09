// cli/commands/tasks.mjs — task management (ls, get, create, update, rm)
//
// Endpoints:
//   GET    /api/projects/:pid/tasks       task:read
//   POST   /api/projects/:pid/tasks       task:write
//   GET    /api/tasks/:id                 task:read
//   PATCH  /api/tasks/:id                task:write
//   DELETE /api/tasks/:id                task:delete:request  (four-eyes, creates deletion_request)

export const describe = "List, get, create, update, or request deletion of tasks";

export const usage = [
  "nopm tasks ls     --project <projectId> [--page <n>] [--limit <n>]",
  "nopm tasks get    <taskId>",
  "nopm tasks create --project <id> --name <n> [--priority low|medium|high|urgent] [--status-type backlog|unstarted|started|completed|canceled] [--milestone <id>] [--due <date>] [--start <date>] [--description <d>] [--points <sp>] [--hours <h>]",
  "nopm tasks update <taskId> [--name <n>] [--priority <p>] [--status-type <t>] [--pct <0-100>] [--milestone <id>] [--due <date>] [--start <date>] [--description <d>] [--points <sp>] [--hours <h>]",
  "nopm tasks rm     <taskId> --reason <why>      (MAKER — creates a pending deletion request)",
  "  flags: --json",
];

const LIST_COLS   = ["id", "name", "status", "status_type", "priority", "milestone_id", "due_date"];
const ROW_COLS    = ["id", "name", "status", "status_type", "priority", "milestone_id", "start_date", "due_date", "completion_pct", "story_points"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls": {
      if (!f.project) ctx.die("usage: nopm tasks ls --project <projectId>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/projects/${f.project}/tasks?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm tasks get <taskId>");
      const { data } = await ctx.api("GET", `/api/tasks/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      if (!f.project || !f.name) ctx.die("usage: nopm tasks create --project <id> --name <name>");
      const body = {
        name: f.name,
        ...(f["status-type"]  && { status_type: f["status-type"] }),
        ...(f.priority        && { priority: f.priority }),
        ...(f.milestone       && { milestone_id: f.milestone }),
        ...(f.description     && { description: f.description }),
        ...(f.due             && { due_date: f.due }),
        ...(f.start           && { start_date: f.start }),
        ...(f.points  != null && { story_points: Number(f.points) }),
        ...(f.hours   != null && { estimate_hours: Number(f.hours) }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${f.project}/tasks`, body);
      console.log("✓ created task", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm tasks update <taskId> [flags]");
      const body = {};
      if (f.name)                  body.name         = f.name;
      if (f["status-type"])        body.status_type  = f["status-type"];
      if (f.priority)              body.priority     = f.priority;
      if (f.pct != null)           body.completion_pct = Number(f.pct);
      if (f.milestone)             body.milestone_id = f.milestone;
      if (f.description)           body.description  = f.description;
      if (f.due)                   body.due_date     = f.due;
      if (f.start)                 body.start_date   = f.start;
      if (f.points != null)        body.story_points = Number(f.points);
      if (f.hours  != null)        body.estimate_hours = Number(f.hours);
      if (!Object.keys(body).length) ctx.die("No update fields supplied.");
      const { data } = await ctx.api("PATCH", `/api/tasks/${id}`, body);
      console.log("✓ updated task", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f._[0];
      if (!id) ctx.die("usage: nopm tasks rm <taskId> --reason <why>");
      if (!f.reason) ctx.die("usage: nopm tasks rm <taskId> --reason <why>");
      const result = await ctx.api("DELETE", `/api/tasks/${id}`, { reason: f.reason });
      console.log("⏸ delete requested — pending a checker's approval (four-eyes).");
      ctx.out(result.data || result, ctx, ["id", "target_type", "target_id", "status", "reason"]);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
