// cli/commands/tokens.mjs — manage API Personal Access Tokens
//
// Endpoints (source of truth: web/src/app/api/tokens/):
//   GET    /api/tokens              token:admin (user session, admin/manager role)
//   POST   /api/tokens              token:admin — body: { name, scopes[], expires_at? }
//   DELETE /api/tokens/:id          token:admin — sets revoked=true
//
// Scope registry (web/src/lib/auth/scopes.ts) defines valid scopes.
// Wildcards accepted: "<resource>:*" and "*".

export const describe = "List, create, or revoke API personal access tokens";

export const usage = [
  "nopm tokens ls                                           list all tokens (sanitised, no hash)",
  "nopm tokens create --name <n> --scopes <scope,scope,...> [--expires <ISO-datetime>]",
  "nopm tokens revoke <id>                                  revoke a token (sets revoked=true)",
  "  flags: --page <n>  --limit <n>  --json",
];

// Known scopes from web/src/lib/auth/scopes.ts (for local validation hint)
const KNOWN_SCOPES = [
  "project:read", "project:write",
  "milestone:read", "milestone:write",
  "task:read", "task:write", "task:delete:request", "task:delete:approve",
  "risk:read", "risk:write",
  "issue:read", "issue:write",
  "clash:read", "clash:write",
  "resource:read", "resource:write",
  "budget:read", "budget:write",
  "document:read", "document:write",
  "change:read", "change:write",
  "decision:read", "decision:write",
  "notification:read",
  "audit:read",
  "assistant:read", "assistant:write",
];

const LIST_COLS = ["id", "name", "prefix", "scopes", "expires_at", "revoked", "last_used_at", "created_at"];
const ROW_COLS  = ["id", "name", "prefix", "scopes", "expires_at", "revoked", "last_used_at", "created_at"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page  = f.page  || 1;
      const limit = f.limit || 20;
      const { data } = await ctx.api("GET", `/api/tokens?page=${page}&limit=${limit}`);
      // Flatten scopes array for table display
      const rows = Array.isArray(data) ? data.map((r) => ({
        ...r,
        scopes: Array.isArray(r.scopes) ? r.scopes.join(",") : r.scopes,
      })) : data;
      ctx.out(rows, ctx, LIST_COLS);
      break;
    }

    case "create": {
      if (!f.name)   ctx.die("usage: nopm tokens create --name <name> --scopes <scope,scope,...> [--expires <ISO-datetime>]");
      if (!f.scopes) ctx.die("usage: nopm tokens create --name <name> --scopes <scope,scope,...>");

      const scopes = String(f.scopes).split(",").map((s) => s.trim()).filter(Boolean);
      if (!scopes.length) ctx.die("--scopes must be a non-empty comma-separated list");

      const body = {
        name: f.name,
        scopes,
        ...(f.expires && { expires_at: f.expires }),
      };

      const { data } = await ctx.api("POST", "/api/tokens", body);
      console.log("✓ created token", data.id);
      console.log("  Token (shown once):", data.token);
      // Display without raw token value in table
      const { token: _raw, ...safe } = data;
      ctx.out({ ...safe, scopes: Array.isArray(safe.scopes) ? safe.scopes.join(",") : safe.scopes }, ctx, ROW_COLS);
      break;
    }

    case "revoke": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm tokens revoke <id>");
      const { data } = await ctx.api("DELETE", `/api/tokens/${id}`);
      console.log("✓ revoked token", id);
      ctx.out(data, ctx, ["revoked"]);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
