// cli/commands/audit.mjs — tail the immutable audit log
//
// Endpoint: GET /api/audit  (audit:read)
// Optional filters: --target-type, --target-id, --action, --actor-id, --channel,
// --since, --after-id, --order (R-85 cursor params: --since/--after-id/--order)

export const describe = "Tail the immutable audit log";

export const usage = [
  "nopm audit [--limit <n>] [--page <n>] [--target-type <t>] [--target-id <id>] [--action <a>] [--actor-id <id>]",
  "           [--channel <c>] [--since <iso>] [--after-id <uuid>] [--order asc|desc]",
];

export async function run(_rest, ctx) {
  const f = ctx.flags;
  const limit  = f.limit  || 20;
  const page   = f.page   || 1;

  const params = new URLSearchParams({ limit, page });
  if (f["target-type"]) params.set("target_type", f["target-type"]);
  if (f["target-id"])   params.set("target_id",   f["target-id"]);
  if (f.action)         params.set("action",       f.action);
  if (f["actor-id"])    params.set("actor_id",     f["actor-id"]);
  if (f.channel)        params.set("channel",      f.channel);
  if (f.since)          params.set("since",        f.since);
  if (f["after-id"])    params.set("after_id",     f["after-id"]);
  if (f.order)          params.set("order",        f.order);

  const { data } = await ctx.api("GET", `/api/audit?${params}`);
  ctx.out(data, ctx, ["created_at", "actor_label", "action", "target_type", "target_id", "channel"]);
}
