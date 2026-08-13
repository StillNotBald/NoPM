// cli/commands/approve.mjs — approve or reject a deletion request (CHECKER)
//
// Endpoints:
//   POST /api/deletion-requests/:id/approve   task:delete:approve
//   POST /api/deletion-requests/:id/reject    task:delete:approve

export const describe = "Approve or reject a pending deletion request (checker — different token)";

export const usage = [
  "nopm approve <requestId>                  approve and commit the deletion",
  "nopm approve reject <requestId> [--reason <why>]   reject the deletion request",
];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;

  // 'nopm approve reject <id> [--reason]'
  if (sub === "reject") {
    const id = arg; // flags._[0] is "reject" itself — never an id
    if (!id) ctx.die("usage: nopm approve reject <requestId> [--reason <why>]");
    const body = ctx.flags.reason ? { reason: ctx.flags.reason } : {};
    const { data } = await ctx.api("POST", `/api/deletion-requests/${id}/reject`, body);
    console.log("✓ rejected.");
    ctx.out(data, ctx);
    return;
  }

  // 'nopm approve <id>'  — sub IS the id (legacy positional)
  const id = sub;
  if (!id) ctx.die("usage: nopm approve <requestId>   (needs a checker token)");
  const { data } = await ctx.api("POST", `/api/deletion-requests/${id}/approve`);
  console.log("✓ approved & committed.");
  ctx.out(data, ctx);
}
