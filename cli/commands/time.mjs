// cli/commands/time.mjs — time entries
//
// Endpoints (source of truth: web/src/app/api/time-entries/):
//   GET    /api/time-entries                time:read   (list; ?project_id=&member_id=)
//   POST   /api/time-entries                time:write  (create)
//   DELETE /api/time-entries/:id            time:write  (delete; no PATCH on this resource)

export const describe = "List, create, or delete time entries (timesheets)";

export const usage = [
  "nopm time ls [--project <uuid>] [--member <uuid>]         list time entries",
  "nopm time create --member <uuid> --project <uuid> --date <YYYY-MM-DD> --hours <h> [--task <uuid>] [--note <text>]",
  "nopm time rm <id>                                          delete a time entry",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "member_id", "project_id", "entry_date", "hours", "cost", "note"];
const ROW_COLS  = ["id", "member_id", "project_id", "task_id", "entry_date", "hours", "cost", "note"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      let url = `/api/time-entries?page=${page}&limit=${limit}`;
      if (f.project) url += `&project_id=${encodeURIComponent(f.project)}`;
      if (f.member)  url += `&member_id=${encodeURIComponent(f.member)}`;
      const { data } = await ctx.api("GET", url);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "create": {
      if (!f.member)  ctx.die("usage: nopm time create --member <uuid> --project <uuid> --date <YYYY-MM-DD> --hours <h> [...]");
      if (!f.project) ctx.die("usage: nopm time create --member <uuid> --project <uuid> --date <YYYY-MM-DD> --hours <h> [...]");
      if (!f.date)    ctx.die("--date <YYYY-MM-DD> is required");
      if (f.hours == null || f.hours === true) ctx.die("--hours <number> is required");
      const body = {
        member_id:  f.member,
        project_id: f.project,
        entry_date: f.date,
        hours:      Number(f.hours),
        ...(f.task && { task_id: f.task }),
        ...(f.note && { note: f.note }),
      };
      const { data } = await ctx.api("POST", "/api/time-entries", body);
      console.log("✓ created time entry", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm time rm <id>");
      await ctx.api("DELETE", `/api/time-entries/${id}`);
      console.log("✓ deleted time entry", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
