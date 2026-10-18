// cli/commands/clashes.mjs — clash detection management
//
// Endpoints (source of truth):
//   GET    /api/clashes                      clash:read   (list all workspace clashes)
//   POST   /api/clashes                      clash:write  (create)
//   GET    /api/clashes/:id                  clash:read   (get)
//   PATCH  /api/clashes/:id                  clash:write  (update)
//   DELETE /api/clashes/:id   clash:delete:request (four-eyes: creates a deletion_request, 202)

export const describe = "List, create, inspect, update, or delete schedule/resource/dependency clashes";

export const usage = [
  "nopm clashes ls                                               list all clashes",
  "nopm clashes get <id>                                         fetch a single clash",
  "nopm clashes create --title <t> --type <type> --severity <s>  [--status <s>] [--description <d>]",
  "nopm clashes update <id> [--title <t>] [--type <type>] [--severity <s>] [--status <s>] [--resolution <r>]",
  "nopm clashes rm <id> --reason <why>   (MAKER) request deletion of a clash; a different person approves it",
  "  type:     schedule | resource | dependency",
  "  severity: low | medium | high | critical",
  "  status:   open | investigating | resolved",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "reference_id", "title", "type", "severity", "status"];
const ROW_COLS  = ["id", "reference_id", "title", "type", "severity", "status", "description", "resolution", "project_a_id", "project_b_id"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/clashes?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm clashes get <id>");
      const { data } = await ctx.api("GET", `/api/clashes/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      if (!f.title)    ctx.die("--title is required");
      if (!f.type)     ctx.die("--type is required (schedule|resource|dependency)");
      if (!f.severity) ctx.die("--severity is required (low|medium|high|critical)");
      const body = {
        title:    f.title,
        type:     f.type,
        severity: f.severity,
        ...(f.status      && { status:      f.status }),
        ...(f.description && { description: f.description }),
        ...(f.resolution  && { resolution:  f.resolution }),
        ...(f["project-a"] && { project_a_id: f["project-a"] }),
        ...(f["project-b"] && { project_b_id: f["project-b"] }),
        ...(f.recommended && { recommended_action: f.recommended }),
      };
      const { data } = await ctx.api("POST", "/api/clashes", body);
      console.log("✓ created clash", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm clashes update <id> [flags]");
      const body = {};
      if (f.title)       body.title       = f.title;
      if (f.type)        body.type        = f.type;
      if (f.severity)    body.severity    = f.severity;
      if (f.status)      body.status      = f.status;
      if (f.description) body.description = f.description;
      if (f.resolution)  body.resolution  = f.resolution;
      if (f["project-a"]) body.project_a_id = f["project-a"];
      if (f["project-b"]) body.project_b_id = f["project-b"];
      if (f.recommended)  body.recommended_action = f.recommended;
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --title, --status, --resolution, etc.");
      const { data } = await ctx.api("PATCH", `/api/clashes/${id}`, body);
      console.log("✓ updated clash", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id || !f.reason) ctx.die("usage: nopm clashes rm <id> --reason <why>");
      const result = await ctx.api("DELETE", `/api/clashes/${id}`, { reason: f.reason });
      console.log("⏸ delete requested — pending a checker's approval (four-eyes).");
      ctx.out(result.data || result, ctx, ["id", "target_type", "target_id", "status", "reason"]);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
