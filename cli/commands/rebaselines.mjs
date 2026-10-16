// cli/commands/rebaselines.mjs — governed rebaseline workflow
//
// Endpoints (source of truth: web/src/app/api/):
//   GET  /api/projects/:id/rebaselines         project:read  — list rebaselines for a project
//   POST /api/projects/:id/rebaselines         project:write — create a rebaseline
//   POST /api/rebaselines/:id/signoff          rebaseline:approve — cast a go/no_go vote (four-eyes: not your own request)
//   POST /api/rebaselines/:id/apply            rebaseline:approve — apply an approved rebaseline
//
// Status flow: draft → pending_approval → approved | rejected → applied
// A rebaseline is pending_approval when the project is locked (governed flow).

export const describe = "Governed rebaseline workflow: list, create, sign off, or apply";

export const usage = [
  "nopm rebaselines ls --project <id>                      list all rebaselines for a project",
  "nopm rebaselines create --project <id> --reason <text>  create a rebaseline (draft or pending_approval)",
  "nopm rebaselines signoff <id> --vote go|no_go [--comment <text>]   cast a signoff vote",
  "nopm rebaselines apply <id>                             apply an approved rebaseline",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "version", "status", "reason", "requested_by", "applied_at", "created_at"];
const ROW_COLS  = ["id", "project_id", "version", "status", "reason", "requested_by", "applied_at", "created_at"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = f.project || f["project-id"];
      if (!projectId) ctx.die("usage: nopm rebaselines ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 20;
      const { data } = await ctx.api("GET", `/api/projects/${projectId}/rebaselines?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "create": {
      const projectId = f.project || f["project-id"];
      if (!projectId) ctx.die("usage: nopm rebaselines create --project <project-id> --reason <reason>");
      if (!f.reason)  ctx.die("usage: nopm rebaselines create --project <project-id> --reason <reason>");
      const body = { reason: f.reason };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/rebaselines`, body);
      console.log("✓ created rebaseline", data.id, `(${data.status})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "signoff": {
      const id = arg || f.id;
      if (!id)       ctx.die("usage: nopm rebaselines signoff <id> --vote go|no_go [--comment <text>]");
      if (!f.vote)   ctx.die("--vote must be 'go' or 'no_go'");
      if (!["go", "no_go"].includes(f.vote)) ctx.die("--vote must be 'go' or 'no_go'");
      const body = {
        vote: f.vote,
        ...(f.comment && { comment: f.comment }),
      };
      const { data } = await ctx.api("POST", `/api/rebaselines/${id}/signoff`, body);
      console.log(`✓ signoff recorded — rebaseline status: ${data.rebaseline?.status ?? "updated"}`);
      if (f.json) {
        ctx.out(data, ctx);
      } else {
        // Print rebaseline summary
        const rb = data.rebaseline ?? {};
        ctx.out(rb, ctx, ROW_COLS);
      }
      break;
    }

    case "apply": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm rebaselines apply <id>");
      const { data } = await ctx.api("POST", `/api/rebaselines/${id}/apply`);
      console.log("✓ rebaseline applied", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
