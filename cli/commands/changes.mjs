// cli/commands/changes.mjs — change request management
//
// Endpoints (source of truth):
//   GET    /api/projects/:id/change-requests           change:read   (list)
//   POST   /api/projects/:id/change-requests           change:write  (create)
//   GET    /api/change-requests/:id                    change:read   (get)
//   PATCH  /api/change-requests/:id                    change:write  (update)
//   DELETE /api/change-requests/:id                    change:write  (delete)
//   POST   /api/change-requests/:id/decision           change:decide (decide) — decision requires change:decide (split from change:write, R-83)

export const describe = "List, create, inspect, update, decide, or delete change requests";

export const usage = [
  "nopm changes ls --project <id>                                list change requests for a project",
  "nopm changes get <id>                                         fetch a single change request",
  "nopm changes create --project <id> --title <t>  [--category <c>] [--priority <p>] [--status <s>] [--description <d>]",
  "nopm changes update <id> [--title <t>] [--category <c>] [--priority <p>] [--description <d>]",
  "nopm changes decide <id> --decision approve|reject|defer --rationale <r>   (the only way to change status past raised/under_review)",
  "nopm changes rm <id>                                          delete a change request",
  "  category: scope | schedule | cost | quality | resource | other",
  "  priority: low | medium | high | critical",
  "  status:   raised | under_review (create only; approve, reject and defer go through `nopm changes decide`)",
  "  flags: --page <n>  --limit <n>  --json",
];

// The only statuses a change request can be RAISED in (createChangeRequestSchema).
// Every other status is a four-eyes decision: `nopm changes decide`.
const RAISE_STATUSES = ["raised", "under_review"];

const LIST_COLS = ["id", "reference_id", "title", "category", "priority", "status", "project_id"];
const ROW_COLS  = [
  "id", "reference_id", "title", "category", "priority", "status",
  "impact_summary", "impact_schedule_days", "impact_cost",
  "decided_by_label", "decision_rationale", "project_id",
];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = arg || f.project;
      if (!projectId) ctx.die("usage: nopm changes ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/projects/${projectId}/change-requests?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm changes get <id>");
      const { data } = await ctx.api("GET", `/api/change-requests/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const projectId = f.project;
      if (!projectId) ctx.die("usage: nopm changes create --project <id> --title <t>");
      if (!f.title)   ctx.die("--title is required");
      if (f.status && !RAISE_STATUSES.includes(f.status)) {
        ctx.die(`--status must be ${RAISE_STATUSES.join(" or ")} when raising a change request; approve, reject or defer it with: nopm changes decide <id> --decision approve|reject|defer --rationale <r>`);
      }
      const body = {
        title: f.title,
        ...(f.category    && { category:    f.category }),
        ...(f.priority    && { priority:    f.priority }),
        ...(f.status      && { status:      f.status }),
        ...(f.description && { description: f.description }),
        ...(f.impact      && { impact_summary: f.impact }),
        ...(f.days != null && f.days !== true && { impact_schedule_days: Number(f.days) }),
        ...(f.cost != null && f.cost !== true && { impact_cost: Number(f.cost) }),
        ...(f.target      && { target_date: f.target }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/change-requests`, body);
      console.log("✓ created change request", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm changes update <id> [flags]");
      if (f.status) {
        ctx.die("update cannot change a status; approve, reject or defer it with: nopm changes decide <id> --decision approve|reject|defer --rationale <r>");
      }
      const body = {};
      if (f.title)       body.title       = f.title;
      if (f.category)    body.category    = f.category;
      if (f.priority)    body.priority    = f.priority;
      if (f.description) body.description = f.description;
      if (f.impact)      body.impact_summary = f.impact;
      if (f.days != null && f.days !== true) body.impact_schedule_days = Number(f.days);
      if (f.cost != null && f.cost !== true) body.impact_cost = Number(f.cost);
      if (f.target)      body.target_date = f.target;
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --title, --priority, --category, --description, etc.");
      const { data } = await ctx.api("PATCH", `/api/change-requests/${id}`, body);
      console.log("✓ updated change request", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "decide": {
      // nopm changes decide <id> --decision approve|reject|defer --rationale <r>
      const id = arg || f.id;
      if (!id)          ctx.die("usage: nopm changes decide <id> --decision approve|reject|defer --rationale <r>");
      if (!f.decision)  ctx.die("--decision is required (approve|reject|defer)");
      if (!f.rationale) ctx.die("--rationale is required");
      const body = { decision: f.decision, rationale: f.rationale };
      const { data } = await ctx.api("POST", `/api/change-requests/${id}/decision`, body);
      console.log(`✓ change request ${id} ${data.status}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm changes rm <id>");
      await ctx.api("DELETE", `/api/change-requests/${id}`);
      console.log("✓ deleted change request", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
