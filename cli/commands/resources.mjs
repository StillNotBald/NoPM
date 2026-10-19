// cli/commands/resources.mjs — resource members
//
// Endpoints (source of truth: web/src/app/api/resources/):
//   GET    /api/resources                  resource:read  (list)
//   POST   /api/resources                  resource:write (create)
//   GET    /api/resources/:id              resource:read  (get one)
//   PATCH  /api/resources/:id             resource:write (update)
//   DELETE /api/resources/:id   resource:delete:request (four-eyes: creates a deletion_request, 202)

export const describe = "List, create, inspect, update, or delete resource members";

export const usage = [
  "nopm resources ls                                         list all resource members",
  "nopm resources get <id>                                   fetch a single resource member",
  "nopm resources create --name <n> [--email <e>] [--role <r>] [--rate <$/hr>] [--capacity <hrs/wk>]",
  "nopm resources update <id> [--name <n>] [--email <e>] [--role <r>] [--rate <$/hr>] [--capacity <hrs/wk>]",
  "nopm resources rm <id> --reason <why>   (MAKER) request deletion of a resource member; a different person approves it",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "name", "role_title", "cost_rate", "capacity_hours_per_week", "email"];
const ROW_COLS  = ["id", "name", "email", "role_title", "cost_rate", "capacity_hours_per_week", "profile_id"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 100;
      const { data } = await ctx.api("GET", `/api/resources?page=${page}&limit=${limit}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "get": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm resources get <id>");
      const { data } = await ctx.api("GET", `/api/resources/${id}`);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "create": {
      if (!f.name) ctx.die("usage: nopm resources create --name <name> [--email <e>] [--role <r>] [--rate <$/hr>] [--capacity <hrs/wk>]");
      const body = {
        name: f.name,
        ...(f.email    && { email: f.email }),
        ...(f.role     && { role_title: f.role }),
        ...(f.rate     != null && f.rate !== true && { cost_rate: Number(f.rate) }),
        ...(f.capacity != null && f.capacity !== true && { capacity_hours_per_week: Number(f.capacity) }),
      };
      const { data } = await ctx.api("POST", "/api/resources", body);
      console.log("✓ created resource member", data.id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "update": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm resources update <id> [flags]");
      const body = {};
      if (f.name)     body.name     = f.name;
      if (f.email)    body.email    = f.email;
      if (f.role)     body.role_title = f.role;
      if (f.rate     != null && f.rate     !== true) body.cost_rate               = Number(f.rate);
      if (f.capacity != null && f.capacity !== true) body.capacity_hours_per_week = Number(f.capacity);
      if (!Object.keys(body).length) ctx.die("No update fields supplied. Use --name, --email, --role, --rate, --capacity.");
      const { data } = await ctx.api("PATCH", `/api/resources/${id}`, body);
      console.log("✓ updated resource member", id);
      ctx.out(data, ctx, ROW_COLS);
      break;
    }

    case "rm":
    case "delete": {
      const id = arg || f.id;
      if (!id || !f.reason) ctx.die("usage: nopm resources rm <id> --reason <why>");
      const result = await ctx.api("DELETE", `/api/resources/${id}`, { reason: f.reason });
      console.log("⏸ delete requested — pending a checker's approval (four-eyes).");
      ctx.out(result.data || result, ctx, ["id", "target_type", "target_id", "status", "reason"]);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
