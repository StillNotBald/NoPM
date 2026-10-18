// cli/commands/budget.mjs — project budget (planned/committed/actual + EVM)
//
// Endpoints (source of truth: web/src/app/api/projects/[id]/budget/):
//   GET    /api/projects/:id/budget         budget:read   (get + EVM computed fields)
//   PUT    /api/projects/:id/budget         budget:write  (upsert planned/committed/currency)
//   PATCH  /api/projects/:id/budget         budget:write  (alias for PUT)

export const describe = "Get or update a project's budget (planned, committed, EVM)";

export const usage = [
  "nopm budget get --project <uuid>                           fetch budget + EVM for a project",
  "nopm budget update --project <uuid> --planned <n> [--committed <n>] [--currency <USD>] [--actual <n>] [--contingency <n>] [--mgmt-reserve <n>]",
  "  flags: --json",
];

const ROW_COLS = [
  "project_id",
  "planned_amount",
  "committed_amount",
  "actual",
  "variance",
  "burn_pct",
  "currency",
  "contingency_reserve",
  "management_reserve",
];

export async function run(rest, ctx) {
  const [sub] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "get":
    case undefined: {
      if (!f.project) ctx.die("--project <uuid> is required  (nopm budget get --project <uuid>)");
      const { data } = await ctx.api("GET", `/api/projects/${f.project}/budget`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      if (!f.project) ctx.die("--project <uuid> is required");
      if (f.planned == null || f.planned === true) ctx.die("--planned <number> is required");
      const body = {
        planned_amount: Number(f.planned),
        ...(f.committed        != null && f.committed        !== true && { committed_amount:    Number(f.committed) }),
        ...(f.currency         && { currency: f.currency }),
        ...(f.actual           != null && f.actual           !== true && { actual_amount:        Number(f.actual) }),
        ...(f.contingency      != null && f.contingency      !== true && { contingency_reserve:  Number(f.contingency) }),
        // --mgmt-reserve is parsed as "mgmt-reserve" by parseFlags (the key is the raw flag name minus --)
        ...(f["mgmt-reserve"]  != null && f["mgmt-reserve"]  !== true && { management_reserve:   Number(f["mgmt-reserve"]) }),
      };
      const { data } = await ctx.api("PUT", `/api/projects/${f.project}/budget`, body);
      console.log("✓ updated budget for project", f.project);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
