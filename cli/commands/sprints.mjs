// cli/commands/sprints.mjs — close a sprint
//
// Endpoints (source of truth):
//   POST /api/sprints/:id/close    sprint:write  (active -> closed)

export const describe = "Close an active sprint, saying where its unfinished tasks go";

export const usage = [
  "nopm sprints close <id> [--move-unfinished-to <backlog|sprint-id>]   close an active sprint",
  "  if attached tasks are unfinished the API answers 422 unfinished_tasks and changes nothing;",
  "  resend with --move-unfinished-to backlog (or another planned/active sprint id of the same project)",
  "  flags: --json",
];

export async function run(rest, ctx) {
  const [sub, arg] = ctx.flags._;
  const f = ctx.flags;

  switch (sub) {
    case "close": {
      const id = arg || f.id;
      if (!id) ctx.die("usage: nopm sprints close <id> [--move-unfinished-to <backlog|sprint-id>]");
      const body = {};
      const to = f["move-unfinished-to"];
      if (to !== undefined) {
        if (to === true) ctx.die("--move-unfinished-to needs a value: backlog or a sprint id");
        body.move_unfinished_to = to;
      }
      const { data } = await ctx.api("POST", `/api/sprints/${id}/close`, body);
      console.log("✓ closed sprint", id);
      ctx.out(data, ctx);
      break;
    }

    default:
      console.log("Unknown subcommand. Available:\n" + usage.join("\n"));
  }
}
