// cli/commands/expenses.mjs — project expenses
//
// Endpoints (source of truth: web/src/app/api/projects/[id]/expenses/ and /api/expenses/[id]/):
//   GET    /api/projects/:id/expenses       budget:read   (list by project)
//   POST   /api/projects/:id/expenses       budget:write  (create)
//   DELETE /api/expenses/:id                budget:write  (delete; no PATCH on this resource)

export const describe = "List, create, or delete project expenses";

export const usage = [
  "nopm expenses ls --project <uuid>                          list expenses for a project",
  "nopm expenses create --project <uuid> --desc <text> --amount <n> [--category <cat>] [--on <YYYY-MM-DD>]",
  "nopm expenses rm <id>                                      delete an expense",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "project_id", "description", "amount", "category", "incurred_on"];
const ROW_COLS  = ["id", "project_id", "description", "amount", "category", "incurred_on"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      if (!f.project) ctx.die("--project <uuid> is required  (nopm expenses ls --project <uuid>)");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/projects/${f.project}/expenses?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "create": {
      if (!f.project) ctx.die("--project <uuid> is required");
      if (!f.desc)    ctx.die("--desc <text> is required");
      if (f.amount == null || f.amount === true) ctx.die("--amount <number> is required");
      const body = {
        description: f.desc,
        amount:      Number(f.amount),
        ...(f.category && { category: f.category }),
        ...(f.on       && { incurred_on: f.on }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${f.project}/expenses`, body);
      console.log("✓ created expense", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm expenses rm <id>");
      await ctx.api("DELETE", `/api/expenses/${id}`);
      console.log("✓ deleted expense", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
