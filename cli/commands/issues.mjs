// cli/commands/issues.mjs — issue tracker management
//
// Endpoints (source of truth):
//   GET    /api/projects/:id/issues          issue:read   (list per project)
//   POST   /api/projects/:id/issues          issue:write  (create)
//   GET    /api/issues/:id                   issue:read   (get)
//   PATCH  /api/issues/:id                   issue:write  (update)
//   DELETE /api/issues/:id                   issue:write  (delete)

export const describe = "List, create, inspect, update, or delete issues";

export const usage = [
  "nopm issues ls --project <id>                                 list issues for a project [--external-ref <ref>]",
  "nopm issues get <id>                                          fetch a single issue",
  "nopm issues create --project <id> --title <t> --priority <p>  [--description <d>] [--status <s>] [--source <slug>] [--external-ref <ref>] [--external-url <url>]",
  "nopm issues update <id> [--title <t>] [--priority <p>] [--status <s>] [--resolution <r>] [--source <slug>] [--external-ref <ref>] [--external-url <url>] [--expected-updated-at <iso>]",
  "nopm issues rm <id>                                           delete an issue",
  "  priority: low | medium | high | urgent",
  "  status:   open | in_progress | resolved | closed",
  "  --source/--external-ref/--external-url: complement seam (R-81) — the system of work this issue mirrors, e.g. --source jira --external-ref PROJ-123",
  "  --expected-updated-at <iso>: optimistic concurrency (R-90) — sends expected_updated_at; a stale value gets 412, not silently overwritten",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "reference_id", "title", "priority", "status", "project_id"];
const ROW_COLS  = ["id", "reference_id", "title", "priority", "status", "resolution", "description", "project_id"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = arg || f.project;
      if (!projectId) ctx.die("usage: nopm issues ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      let url = `/api/projects/${projectId}/issues?page=${page}&limit=${limit}&view=full`;
      if (f["external-ref"]) url += `&external_ref=${encodeURIComponent(f["external-ref"])}`;
      const { data } = await ctx.api("GET", url);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm issues get <id>");
      const { data } = await ctx.api("GET", `/api/issues/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const projectId = f.project;
      if (!projectId) ctx.die("usage: nopm issues create --project <id> --title <t> --priority <p>");
      if (!f.title)   ctx.die("--title is required");
      if (!f.priority) ctx.die("--priority is required (low|medium|high|urgent)");
      const body = {
        title:    f.title,
        priority: f.priority,
        ...(f.description && { description: f.description }),
        ...(f.status      && { status:      f.status }),
        ...(f.resolution  && { resolution:  f.resolution }),
        ...(f.due         && { due_date:    f.due }),
        ...(f.severity    && { severity:    f.severity }),
        ...(f.source            && { source: f.source }),
        ...(f["external-ref"]   && { external_ref: f["external-ref"] }),
        ...(f["external-url"]   && { external_url: f["external-url"] }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/issues`, body);
      console.log("✓ created issue", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm issues update <id> [flags]");
      const body = {};
      if (f.title)       body.title       = f.title;
      if (f.priority)    body.priority    = f.priority;
      if (f.description) body.description = f.description;
      if (f.status)      body.status      = f.status;
      if (f.resolution)  body.resolution  = f.resolution;
      if (f.due)         body.due_date    = f.due;
      if (f.severity)    body.severity    = f.severity;
      if (f.source)              body.source       = f.source;
      if (f["external-ref"])     body.external_ref = f["external-ref"];
      if (f["external-url"])     body.external_url = f["external-url"];
      if (f["expected-updated-at"]) body.expected_updated_at = f["expected-updated-at"];
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --title, --priority, --status, etc.");
      const { data } = await ctx.api("PATCH", `/api/issues/${id}`, body);
      console.log("✓ updated issue", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm issues rm <id>");
      await ctx.api("DELETE", `/api/issues/${id}`);
      console.log("✓ deleted issue", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
