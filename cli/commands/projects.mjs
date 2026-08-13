// cli/commands/projects.mjs — EXEMPLAR module for the nopm command architecture
//
// Pattern every other command module should follow:
//   export describe / usage / run(rest, ctx)
//   rest[0] = subcommand; ctx = { api, out, die, flags }
//   Support --json everywhere (ctx.out handles it)
//   Mutating commands print a one-line confirmation then the row
//   Flags: --name, --code, --program, --rag, --pct, --description, --phase,
//          --start, --target, --currency, --reason, --page, --limit
//
// Endpoints (source of truth):
//   GET    /api/projects                  project:read
//   POST   /api/projects                  project:write
//   GET    /api/projects/:id              project:read
//   PATCH  /api/projects/:id             project:write
//   POST   /api/projects/:id/lock         project:write
//   POST   /api/projects/:id/unlock       project:write
//   DELETE /api/projects/:id             project:write

export const describe = "List, create, inspect, update, lock, unlock, or delete projects";

export const usage = [
  "nopm projects ls                                         list all projects",
  "nopm projects get <id>                                   fetch a single project",
  "nopm projects create --name <n> --code <c> [--program <p>] [--rag <status>] [--description <d>] [--phase <ph>] [--start <date>] [--target <date>] [--currency <USD>]",
  "nopm projects update <id> [--name <n>] [--code <c>] [--rag <status>] [--pct <0-100>] [--description <d>] [--phase <ph>] [--start <date>] [--target <date>]",
  "nopm projects lock   <id> [--reason <why>]               lock project timeline",
  "nopm projects unlock <id>                                unlock project timeline",
  "nopm projects rm     <id>                                hard-delete a project (project:write)",
  "  flags: --page <n>  --limit <n>  --json",
];

// Columns shown in table mode for list views
const LIST_COLS = ["id", "code", "name", "rag_status", "completion_pct", "is_locked", "phase"];
// Columns shown for a single project row
const ROW_COLS  = ["id", "code", "name", "rag_status", "completion_pct", "is_locked", "phase", "start_date", "target_date"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/projects?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm projects get <id>");
      const { data } = await ctx.api("GET", `/api/projects/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      if (!f.name || !f.code) ctx.die("usage: nopm projects create --name <name> --code <code>   (code: short unique id, 1-32 chars, e.g. APOLLO)");
      const body = {
        name: f.name,
        code: f.code,
        ...(f.program     && { program: f.program }),
        ...(f.description && { description: f.description }),
        ...(f.rag         && { rag_status: f.rag }),
        ...(f.phase       && { phase: f.phase }),
        ...(f.start       && { start_date: f.start }),
        ...(f.target      && { target_date: f.target }),
        ...(f.currency    && { currency: f.currency }),
      };
      const { data } = await ctx.api("POST", "/api/projects", body);
      console.log("✓ created project", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm projects update <id> [flags]");
      const body = {};
      if (f.name)        body.name        = f.name;
      if (f.code)        body.code        = f.code;
      if (f.program)     body.program     = f.program;
      if (f.description) body.description = f.description;
      if (f.rag)         body.rag_status  = f.rag;
      if (f.pct   != null) body.completion_pct = Number(f.pct);
      if (f.phase)       body.phase       = f.phase;
      if (f.start)       body.start_date  = f.start;
      if (f.target)      body.target_date = f.target;
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --name, --rag, --pct, etc.");
      const { data } = await ctx.api("PATCH", `/api/projects/${id}`, body);
      console.log("✓ updated project", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "lock": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm projects lock <id> [--reason <why>]");
      const body = f.reason ? { reason: f.reason } : {};
      const { data } = await ctx.api("POST", `/api/projects/${id}/lock`, body);
      console.log("✓ locked project", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "unlock": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm projects unlock <id>");
      const { data } = await ctx.api("POST", `/api/projects/${id}/unlock`);
      console.log("✓ unlocked project", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm projects rm <id>");
      await ctx.api("DELETE", `/api/projects/${id}`);
      console.log("✓ deleted project", id);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
