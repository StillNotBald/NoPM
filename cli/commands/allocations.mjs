// cli/commands/allocations.mjs — resource allocations
//
// Endpoints (source of truth: web/src/app/api/allocations/):
//   GET    /api/allocations                resource:read  (list)
//   POST   /api/allocations                resource:write (create)
//   GET    /api/allocations/:id            resource:read  (get one)
//   PATCH  /api/allocations/:id           resource:write (update)
//   DELETE /api/allocations/:id           resource:write (delete)

export const describe = "List, create, inspect, update, or delete resource allocations";

export const usage = [
  "nopm allocations ls                                          list all allocations",
  "nopm allocations get <id>                                    fetch a single allocation",
  "nopm allocations create --member <uuid> [--project <uuid>] [--task <uuid>] [--pct <0-500>] [--hours <h>] [--start <datetime>] [--end <datetime>] [--idempotency-key <key>]",
  "nopm allocations update <id> [--member <uuid>] [--project <uuid>] [--task <uuid>] [--pct <0-500>] [--hours <h>] [--start <datetime>] [--end <datetime>]",
  "nopm allocations rm     <id>                                 delete an allocation",
  "  --idempotency-key <key>: retry-safe create — the same key (24 h) returns the first allocation, not a duplicate",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "member_id", "project_id", "task_id", "allocation_pct", "hours", "window_start", "window_end"];
const ROW_COLS  = LIST_COLS;

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/allocations?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm allocations get <id>");
      const { data } = await ctx.api("GET", `/api/allocations/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      if (!f.member) ctx.die("usage: nopm allocations create --member <uuid> [--project <uuid>] [--pct <n>] ...");
      const body = {
        member_id: f.member,
        ...(f.project && { project_id: f.project }),
        ...(f.task    && { task_id: f.task }),
        ...(f.pct   != null && f.pct   !== true && { allocation_pct: Number(f.pct) }),
        ...(f.hours != null && f.hours !== true && { hours: Number(f.hours) }),
        ...(f.start   && { window_start: f.start }),
        ...(f.end     && { window_end: f.end }),
      };
      const { data, warnings } = await ctx.api("POST", "/api/allocations", body);
      for (const w of warnings || []) console.error("! " + w);
      console.log("✓ created allocation", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm allocations update <id> [flags]");
      const body = {};
      if (f.member)                                 body.member_id      = f.member;
      if (f.project)                                body.project_id     = f.project;
      if (f.task)                                   body.task_id        = f.task;
      if (f.pct   != null && f.pct   !== true)      body.allocation_pct = Number(f.pct);
      if (f.hours != null && f.hours !== true)      body.hours          = Number(f.hours);
      if (f.start)                                  body.window_start   = f.start;
      if (f.end)                                    body.window_end     = f.end;
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --member, --project, --pct, --hours, etc.");
      const { data, warnings } = await ctx.api("PATCH", `/api/allocations/${id}`, body);
      for (const w of warnings || []) console.error("! " + w);
      console.log("✓ updated allocation", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm allocations rm <id>");
      await ctx.api("DELETE", `/api/allocations/${id}`);
      console.log("✓ deleted allocation", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
