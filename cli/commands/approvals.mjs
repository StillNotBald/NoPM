// cli/commands/approvals.mjs — list pending deletion requests
//
// Endpoint: GET /api/deletion-requests  (task:read or audit:read)

export const describe = "List pending (or all) deletion requests";

export const usage = [
  "nopm approvals [--status pending|approved|rejected|committed] [--page <n>] [--limit <n>]",
];

export async function run(_rest, ctx) {
  const f = ctx.flags;
  const status = f.status || "pending";
  const page   = f.page   || 1;
  const limit  = f.limit  || 20;
  const { data } = await ctx.api(
    "GET",
    `/api/deletion-requests?status=${status}&page=${page}&limit=${limit}`,
  );
  ctx.out(data, ctx, ["id", "target_type", "target_id", "requested_by_label", "status", "created_at"]);
}
