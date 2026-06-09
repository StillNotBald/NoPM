// cli/commands/search.mjs — full-workspace record search
//
// Endpoint (source of truth: web/src/app/api/search/route.ts):
//   GET /api/search?q=<query>   project:read
//
// Searches across: projects, tasks, risks, issues, clashes, documents,
// change_requests, decisions — case-insensitive, capped ~6 per type, ~30 total.
// Response shape: { data: [ { type, id, label, sublabel?, href, reference_id? } ] }

export const describe = "Full-workspace search — prints type, label, sublabel, and href";

export const usage = [
  "nopm search q <query>       search across projects, tasks, risks, issues, clashes, documents, change-requests, decisions",
  "  flags: --json",
];

const RESULT_COLS = ["type", "label", "sublabel", "reference_id", "href", "id"];

export async function run(rest, ctx) {
  const [sub, ...args] = ctx.flags._;
  const f = ctx.flags;

  // Accept: `nopm search q <query>` or `nopm search <query>`
  let query;
  if (sub === "q") {
    // query is remaining positional args joined (allows multi-word without quotes)
    query = args.join(" ").trim() || f.q;
  } else if (sub) {
    // `nopm search <query>` without "q" subcommand — treat sub as part of query
    query = [sub, ...args].join(" ").trim();
  } else {
    query = f.q;
  }

  if (!query) ctx.die("usage: nopm search q <query>");

  const encoded = encodeURIComponent(query);
  const { data } = await ctx.api("GET", `/api/search?q=${encoded}`);

  if (!Array.isArray(data) || !data.length) {
    console.log("(no results)");
    return;
  }

  ctx.out(data, ctx, RESULT_COLS);
}
