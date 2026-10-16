// cli/commands/review.mjs — "what is waiting for me?"
//
// Endpoint: GET /api/review  (read-only; a token needs a read scope for at
// least one family: task:read | audit:read, change:read, time:read, project:read)
//
// Lists every governed decision waiting on a person — task/project deletion
// requests, change requests, submitted timesheets, rebaselines awaiting
// sign-off — oldest first, with whether YOU may decide each one. Listing never
// decides anything: deletions are decided with `nopm approve`, change requests
// with `nopm changes decide`, rebaselines with `nopm rebaselines signoff`,
// timesheets in the console.

export const describe = "List the governed decisions waiting on a person (deletions, change requests, timesheets, rebaselines)";

export const usage = [
  "nopm review [--kind <kind>[,<kind>...]] [--page <n>] [--limit <n>]   pending decisions, oldest first",
  "  kind: task_deletion | project_deletion | change_request | timesheet | rebaseline",
  "  decide column: \"yes\", or \"no — <why>\" (missing scope, or four-eyes: you raised it)",
  "  flags: --json (full items, incl. summary/project_id)",
];

const COLUMNS = ["kind", "title", "project", "requested_by", "requested_at", "id", "decide"];

/** One display row per item: short date, and the can_decide verdict spelled out. */
export function toRows(items) {
  return items.map((i) => ({
    kind: i.kind,
    title: i.title,
    project: i.project_name ?? "",
    requested_by: i.requested_by_label ?? "",
    requested_at: String(i.requested_at ?? "").slice(0, 16).replace("T", " "),
    id: i.id,
    decide: i.can_decide ? "yes" : `no — ${i.reason_if_not ?? "not permitted"}`,
  }));
}

export async function run(_rest, ctx) {
  const f = ctx.flags;
  if (f.kind === true) ctx.die("--kind needs a value, e.g. --kind timesheet,change_request");

  const params = new URLSearchParams();
  if (f.kind) params.set("kind", String(f.kind));
  params.set("page", String(f.page || 1));
  params.set("limit", String(f.limit || 50));

  const res = await ctx.api("GET", `/api/review?${params.toString()}`);
  const items = res.data ?? [];

  ctx.out(f.json ? items : toRows(items), ctx, f.json ? undefined : COLUMNS);

  // Notes go to stderr so `--json` stdout stays machine-parseable.
  if (Array.isArray(res.hidden_kinds) && res.hidden_kinds.length > 0) {
    console.error(
      `note: not shown (this token cannot read them): ${res.hidden_kinds.join(", ")} — an empty list is not proof nothing is pending`,
    );
  }
  const shown = (Number(res.page || 1) - 1) * Number(res.limit || items.length) + items.length;
  if (typeof res.total === "number" && res.total > shown) {
    console.error(`note: showing ${items.length} of ${res.total} — use --page ${Number(res.page || 1) + 1} for more`);
  }
}
