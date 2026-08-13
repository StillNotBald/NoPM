// cli/commands/timeline.mjs — the Mainline portfolio graph (R-28)
//
// Endpoints:
//   GET /api/timeline    project:read

export const describe = "Fetch the Mainline portfolio graph (every artifact + dependency DAG in one read)";

export const usage = [
  "nopm timeline                summary counts per lane",
  "nopm timeline --json         full graph (lanes, nodes, edges)",
];

export async function run(rest, ctx) {
  const { data } = await ctx.api("GET", "/api/timeline");

  if (ctx.flags.json) {
    ctx.out(data, ctx);
    return;
  }

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const byType = {};
  for (const n of nodes) byType[n.type ?? "unknown"] = (byType[n.type ?? "unknown"] ?? 0) + 1;

  const rows = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));
  ctx.out(rows, ctx, ["type", "count"]);
  console.log(`\n${nodes.length} nodes, ${edges.length} edges. Use --json for the full graph.`);
}
