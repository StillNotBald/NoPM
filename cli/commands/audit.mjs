// cli/commands/audit.mjs — tail the immutable audit log
//
// Endpoint: GET /api/audit  (audit:read)
// Optional filters: --target-type, --target-id, --action, --actor-id

export const describe = "Tail the immutable audit log";

export const usage = [
  "nopm audit [--limit <n>] [--page <n>] [--target-type <t>] [--target-id <id>] [--action <a>] [--actor-id <id>]",
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

  const { data } = await ctx.api("GET", `/api/audit?${params}`);
  ctx.out(data, ctx, ["created_at", "actor_label", "action", "target_type", "target_id"]);
}
