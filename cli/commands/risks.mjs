// cli/commands/risks.mjs — risk register management
//
// Endpoints (source of truth):
//   GET    /api/projects/:id/risks           risk:read   (list per project)
//   POST   /api/projects/:id/risks           risk:write  (create)
//   GET    /api/risks/:id                    risk:read   (get)
//   PATCH  /api/risks/:id                    risk:write  (update)
//   DELETE /api/risks/:id                    risk:write  (delete)

export const describe = "List, create, inspect, update, or delete risks";

export const usage = [
  "nopm risks ls --project <id>                                  list risks for a project [--external-ref <ref>]",
  "nopm risks get <id>                                           fetch a single risk",
  "nopm risks create --project <id> --title <t> --severity <s> --likelihood <l>  [--description <d>] [--mitigation <m>] [--status <s>] [--source <slug>] [--external-ref <ref>] [--external-url <url>]",
  "nopm risks update <id> [--title <t>] [--severity <s>] [--likelihood <l>] [--status <s>] [--mitigation <m>] [--resolution <r>] [--source <slug>] [--external-ref <ref>] [--external-url <url>] [--expected-updated-at <iso>]",
  "nopm risks rm <id>                                            delete a risk",
  "  severity/likelihood: low | medium | high | critical",
  "  status: open | mitigating | closed | accepted  (closing a risk needs --resolution <note>; without it the API answers 422)",
  "  --source/--external-ref/--external-url: complement seam (R-81) — the system of work this risk mirrors, e.g. --source jira --external-ref PROJ-123",
  "  --expected-updated-at <iso>: optimistic concurrency (R-90) — sends expected_updated_at; a stale value gets 412, not silently overwritten",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "reference_id", "title", "severity", "likelihood", "status", "project_id"];
const ROW_COLS  = ["id", "reference_id", "title", "severity", "likelihood", "status", "category", "mitigation", "project_id"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = arg || f.project;
      if (!projectId) ctx.die("usage: nopm risks ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      let url = `/api/projects/${projectId}/risks?page=${page}&limit=${limit}`;
      if (f["external-ref"]) url += `&external_ref=${encodeURIComponent(f["external-ref"])}`;
      const { data } = await ctx.api("GET", url);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm risks get <id>");
      const { data } = await ctx.api("GET", `/api/risks/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const projectId = f.project;
      if (!projectId)  ctx.die("usage: nopm risks create --project <id> --title <t> --severity <s> --likelihood <l>");
      if (!f.title)    ctx.die("--title is required");
      if (!f.severity) ctx.die("--severity is required (low|medium|high|critical)");
      if (!f.likelihood) ctx.die("--likelihood is required (low|medium|high|critical)");
      const body = {
        title:      f.title,
        severity:   f.severity,
        likelihood: f.likelihood,
        ...(f.description && { description: f.description }),
        ...(f.mitigation  && { mitigation:  f.mitigation }),
        ...(f.status      && { status:      f.status }),
        ...(f.resolution  && { resolution:  f.resolution }),
        ...(f.category    && { category:    f.category }),
        ...(f.due         && { due_date:    f.due }),
        ...(f.source            && { source: f.source }),
        ...(f["external-ref"]   && { external_ref: f["external-ref"] }),
        ...(f["external-url"]   && { external_url: f["external-url"] }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/risks`, body);
      console.log("✓ created risk", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm risks update <id> [flags]");
      const body = {};
      if (f.title)       body.title       = f.title;
      if (f.severity)    body.severity    = f.severity;
      if (f.likelihood)  body.likelihood  = f.likelihood;
      if (f.description) body.description = f.description;
      if (f.mitigation)  body.mitigation  = f.mitigation;
      if (f.status)      body.status      = f.status;
      if (f.resolution)  body.resolution  = f.resolution;
      if (f.category)    body.category    = f.category;
      if (f.due)         body.due_date    = f.due;
      if (f.source)              body.source       = f.source;
      if (f["external-ref"])     body.external_ref = f["external-ref"];
      if (f["external-url"])     body.external_url = f["external-url"];
      if (f["expected-updated-at"]) body.expected_updated_at = f["expected-updated-at"];
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --title, --severity, --status, etc.");
      const { data } = await ctx.api("PATCH", `/api/risks/${id}`, body);
      console.log("✓ updated risk", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm risks rm <id>");
      await ctx.api("DELETE", `/api/risks/${id}`);
      console.log("✓ deleted risk", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
