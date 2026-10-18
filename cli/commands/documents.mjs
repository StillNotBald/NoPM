// cli/commands/documents.mjs — manage workspace documents
//
// Endpoints (source of truth: web/src/app/api/documents/):
//   GET    /api/documents                  document:read — ?project_id ?folder ?status ?doc_type ?page ?limit
//   POST   /api/documents                  document:write — body: { title, doc_type, project_id?, folder?, body?, ... }
//   GET    /api/documents/:id              document:read
//   PATCH  /api/documents/:id             document:write
//   DELETE /api/documents/:id             document:write
//
// Valid doc_type: charter | plan | raid | status_report | change_request | minutes | spec | other
// Valid status:   draft | in_review | approved | archived

export const describe = "List, create, get, update, or delete documents";

export const usage = [
  "nopm documents ls [--project <id>] [--folder <f>] [--status <s>] [--doc-type <t>]   list documents",
  "nopm documents get <id>                                                               fetch a single document",
  "nopm documents create --title <t> --doc-type <dt> [--project <id>] [--folder <f>] [--body <text>] [--status <s>] [--summary <s>] [--url <u>]",
  "nopm documents update <id> [--title <t>] [--doc-type <dt>] [--folder <f>] [--status <s>] [--body <text>] [--summary <s>]",
  "nopm documents rm <id>                                                                hard-delete a document",
  "  doc-type values: charter | plan | raid | status_report | change_request | minutes | spec | other",
  "  status values:   draft | in_review | approved | archived",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "reference_id", "title", "doc_type", "folder", "status", "created_at"];
const ROW_COLS  = ["id", "reference_id", "title", "doc_type", "folder", "status", "version", "project_id", "created_at"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 20;
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      // --project accepts a project UUID
      if (f.project)    params.set("project_id", f.project);
      if (f.folder)     params.set("folder",     f.folder);
      if (f.status)     params.set("status",     f.status);
      // --doc-type is hyphenated in CLI, snake_case in API
      const dt = f["doc-type"] || f.doc_type;
      if (dt) params.set("doc_type", dt);
      const { data } = await ctx.api("GET", `/api/documents?${params}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm documents get <id>");
      const { data } = await ctx.api("GET", `/api/documents/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      const dt = f["doc-type"] || f.doc_type;
      if (!f.title) ctx.die("usage: nopm documents create --title <title> --doc-type <type>");
      if (!dt)      ctx.die("usage: nopm documents create --title <title> --doc-type <type>");
      const body = {
        title:    f.title,
        doc_type: dt,
        ...(f.project  && { project_id:   f.project }),
        ...(f.folder   && { folder:        f.folder }),
        ...(f.body     && { body:          f.body }),
        ...(f.status   && { status:        f.status }),
        ...(f.summary  && { summary:       f.summary }),
        ...(f.url      && { external_url:  f.url }),
      };
      const { data } = await ctx.api("POST", "/api/documents", body);
      console.log("✓ created document", data.id, `(${data.reference_id})`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm documents update <id> [flags]");
      const body = {};
      const dt = f["doc-type"] || f.doc_type;
      if (f.title)   body.title        = f.title;
      if (dt)        body.doc_type     = dt;
      if (f.folder)  body.folder       = f.folder;
      if (f.status)  body.status       = f.status;
      if (f.body)    body.body         = f.body;
      if (f.summary) body.summary      = f.summary;
      if (f.url)     body.external_url = f.url;
      if (f.project) body.project_id   = f.project;
      if (!Object.keys(body).length) ctx.die("No update fields supplied.");
      const { data } = await ctx.api("PATCH", `/api/documents/${id}`, body);
      console.log("✓ updated document", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm documents rm <id>");
      await ctx.api("DELETE", `/api/documents/${id}`);
      console.log("✓ deleted document", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
