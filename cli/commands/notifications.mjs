// cli/commands/notifications.mjs — manage in-app notifications
//
// Endpoints (source of truth: web/src/app/api/notifications/):
//   GET   /api/notifications                notification:read — ?unread=1 ?page ?limit
//   PATCH /api/notifications/:id            notification:read — mark single as read
//   POST  /api/notifications/read-all       notification:read — mark all unread as read
//
// Scope required: notification:read (read-only scope covers mark-as-read — personal action)

export const describe = "List and mark notifications as read";

export const usage = [
  "nopm notifications ls [--unread]                        list notifications (--unread = unread only)",
  "nopm notifications read <id>                            mark a single notification as read",
  "nopm notifications read-all                             mark all unread notifications as read",
  "  flags: --page <n>  --limit <n>  --json",
];

const LIST_COLS = ["id", "type", "title", "body", "read_at", "created_at"];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "ls":
    case undefined: {
      const page   = f.page  || 1;
      const limit  = f.limit || 20;
      const unread = f.unread ? "&unread=1" : "";
      const { data } = await ctx.api("GET", `/api/notifications?page=${page}&limit=${limit}${unread}`);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "read": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm notifications read <id>");
      const { data } = await ctx.api("PATCH", `/api/notifications/${id}`);
      console.log("✓ marked notification as read", id);
      ctx.out(data, ctx, LIST_COLS);
      break;
    }

    case "read-all": {
      const { data } = await ctx.api("POST", "/api/notifications/read-all");
      console.log(`✓ marked ${data.updated} notification(s) as read`);
      ctx.out(data, ctx, ["updated"]);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
