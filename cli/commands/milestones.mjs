// cli/commands/milestones.mjs — milestone management
//
// Endpoints (source of truth):
//   GET    /api/projects/:id/milestones      milestone:read   (list)
//   POST   /api/projects/:id/milestones      milestone:write  (create)
//   GET    /api/milestones/:id               milestone:read   (get)
//   PATCH  /api/milestones/:id               milestone:write  (update)
//   DELETE /api/milestones/:id               milestone:write  (delete)

export const describe = "List, create, inspect, update, or delete milestones";

export const usage = [
  "nopm milestones ls --project <id>                             list milestones for a project",
  "nopm milestones get <id>                                      fetch a single milestone",
  "nopm milestones create --project <id> --name <n> [--status <s>] [--target <date>] [--pct <0-100>] [--description <d>]",
  "nopm milestones update <id> [--name <n>] [--status <s>] [--target <date>] [--pct <0-100>] [--description <d>] [--confirm-open-tasks] [--expected-updated-at <iso>]",
  "  completing a milestone with open tasks answers 422 open_tasks; resend with --confirm-open-tasks to complete it anyway",
  "nopm milestones rm <id>                                       delete a milestone",
  "  statuses: not_started | on_track | at_risk | delayed | completed",
  "  --expected-updated-at <iso>: optimistic concurrency (R-90) — sends expected_updated_at; a stale value gets 412, not silently overwritten",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "name", "status", "completion_pct", "target_date", "project_id"];
const ROW_COLS  = ["id", "name", "status", "completion_pct", "target_date", "start_date", "description", "project_id"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = arg || f.project;
      if (!projectId) ctx.die("usage: nopm milestones ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/projects/${projectId}/milestones?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm milestones get <id>");
      const { data } = await ctx.api("GET", `/api/milestones/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const projectId = f.project;
      if (!projectId) ctx.die("usage: nopm milestones create --project <project-id> --name <name> [...]");
      if (!f.name)    ctx.die("usage: nopm milestones create --project <project-id> --name <name> [...]");
      const body = {
        name: f.name,
        ...(f.status      && { status: f.status }),
        ...(f.target      && { target_date: f.target }),
        ...(f.pct   != null && f.pct !== true && { completion_pct: Number(f.pct) }),
        ...(f.description && { description: f.description }),
        ...(f.start       && { start_date: f.start }),
        ...(f.deliverable && { deliverable: f.deliverable }),
        ...(f.order != null && f.order !== true && { sort_order: Number(f.order) }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/milestones`, body);
      console.log("✓ created milestone", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm milestones update <id> [flags]");
      const body = {};
      if (f.name)        body.name        = f.name;
      if (f.status)      body.status      = f.status;
      if (f.target)      body.target_date = f.target;
      if (f.pct   != null && f.pct !== true)   body.completion_pct = Number(f.pct);
      if (f.description) body.description = f.description;
      if (f.start)       body.start_date  = f.start;
      if (f.deliverable) body.deliverable = f.deliverable;
      if (f.order != null && f.order !== true)  body.sort_order     = Number(f.order);
      if (f["confirm-open-tasks"]) body.confirm_open_tasks = true;
      if (f["expected-updated-at"]) body.expected_updated_at = f["expected-updated-at"];
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --name, --status, --target, --pct, etc.");
      const { data } = await ctx.api("PATCH", `/api/milestones/${id}`, body);
      console.log("✓ updated milestone", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm milestones rm <id>");
      await ctx.api("DELETE", `/api/milestones/${id}`);
      console.log("✓ deleted milestone", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
