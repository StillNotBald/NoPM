// cli/commands/approve.mjs — approve or reject a deletion request (CHECKER)
//
// Endpoints:
//   POST /api/deletion-requests/:id/approve   task:delete:approve
//   POST /api/deletion-requests/:id/reject    task:delete:approve
//   POST /api/deletion-requests/:id/withdraw  task:delete:request (the requester only)

export const describe = "Approve or reject a pending deletion request (checker — a different person; a token counts as the human who created it)";

export const usage = [
  "nopm approve <requestId>                  approve and commit the deletion",
  "nopm approve reject <requestId> [--reason <why>]   reject the deletion request",
  "nopm approve withdraw <requestId>         withdraw YOUR OWN pending deletion request (maker; task:delete:request / project:delete:request)",
  "  only admins and managers can approve; a token approves with the role of the person who created it (403 otherwise)",
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

  // 'nopm approve withdraw <id>' — the maker takes their own request back (Q-GOV-27)
  if (sub === "withdraw") {
    if (!arg) ctx.die("usage: nopm approve withdraw <requestId>");
    const { data } = await ctx.api("POST", `/api/deletion-requests/${arg}/withdraw`);
    console.log("✓ withdrawn.");
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
