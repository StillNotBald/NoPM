// cli/commands/decisions.mjs — decision log management
//
// Endpoints (source of truth):
//   GET    /api/projects/:id/decisions        decision:read   (list)
//   POST   /api/projects/:id/decisions        decision:write  (create)
//   GET    /api/decisions/:id                 decision:read   (get)
//   PATCH  /api/decisions/:id                 decision:write  (update)
//   DELETE /api/decisions/:id                 decision:write  (delete)

export const describe = "List, create, inspect, update, or delete decision log entries";

export const usage = [
  "nopm decisions ls --project <id>                              list decisions for a project [--external-ref <ref>]",
  "nopm decisions get <id>                                       fetch a single decision",
  "nopm decisions create --project <id> --title <t> --decision <d>  [--rationale <r>] [--context <c>] [--status <s>] [--source <slug>] [--external-ref <ref>] [--external-url <url>]",
  "nopm decisions update <id> [--title <t>] [--decision <d>] [--rationale <r>] [--status <s>] [--source <slug>] [--external-ref <ref>] [--external-url <url>]",
  "nopm decisions rm <id>                                        delete a decision",
  "  status: proposed | accepted | superseded | rejected",
  "  --source/--external-ref/--external-url: complement seam (R-81) — the system of work this decision mirrors, e.g. --source jira --external-ref PROJ-123",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "reference_id", "title", "status", "decided_by_label", "decided_at", "project_id"];
const ROW_COLS  = [
  "id", "reference_id", "title", "status", "decision", "rationale",
  "decided_by_label", "decided_at", "context", "project_id",
];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const projectId = arg || f.project;
      if (!projectId) ctx.die("usage: nopm decisions ls --project <project-id>");
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      let url = `/api/projects/${projectId}/decisions?page=${page}&limit=${limit}`;
      if (f["external-ref"]) url += `&external_ref=${encodeURIComponent(f["external-ref"])}`;
      const { data } = await ctx.api("GET", url);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm decisions get <id>");
      const { data } = await ctx.api("GET", `/api/decisions/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const projectId = f.project;
      if (!projectId) ctx.die("usage: nopm decisions create --project <id> --title <t> --decision <d>");
      if (!f.title)   ctx.die("--title is required");
      if (!f.decision) ctx.die("--decision is required (the decision text, e.g. 'Use PostgreSQL')");
      const body = {
        title:    f.title,
        decision: f.decision,
        ...(f.rationale && { rationale: f.rationale }),
        ...(f.context   && { context:   f.context }),
        ...(f.options   && { options:   f.options }),
        ...(f.status    && { status:    f.status }),
        ...(f.at        && { decided_at: f.at }),
        ...(f.supersedes && { supersedes: f.supersedes }),
        ...(f.source            && { source: f.source }),
        ...(f["external-ref"]   && { external_ref: f["external-ref"] }),
        ...(f["external-url"]   && { external_url: f["external-url"] }),
      };
      const { data } = await ctx.api("POST", `/api/projects/${projectId}/decisions`, body);
      console.log("✓ created decision", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm decisions update <id> [flags]");
      const body = {};
      if (f.title)      body.title      = f.title;
      if (f.decision)   body.decision   = f.decision;
      if (f.rationale)  body.rationale  = f.rationale;
      if (f.context)    body.context    = f.context;
      if (f.options)    body.options    = f.options;
      if (f.status)     body.status     = f.status;
      if (f.at)         body.decided_at = f.at;
      if (f.supersedes) body.supersedes = f.supersedes;
      if (f.source)              body.source       = f.source;
      if (f["external-ref"])     body.external_ref = f["external-ref"];
      if (f["external-url"])     body.external_url = f["external-url"];
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --title, --decision, --status, etc.");
      const { data } = await ctx.api("PATCH", `/api/decisions/${id}`, body);
      console.log("✓ updated decision", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm decisions rm <id>");
      await ctx.api("DELETE", `/api/decisions/${id}`);
      console.log("✓ deleted decision", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
