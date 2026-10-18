// cli/commands/openapi.mjs — fetch the public OpenAPI spec
//
// Endpoints:
//   GET /api/openapi.json    public (no auth)

import { loadConfig } from "../lib/api.mjs";

export const describe = "Fetch the public OpenAPI 3.1 spec (no token needed)";

export const usage = [
  "nopm openapi                 operation index (method + path + summary)",
  "nopm openapi --json          full spec JSON (pipe to a file or jq)",
];

export async function run(rest, ctx) {
  const cfg = loadConfig();
  const res = await fetch(cfg.url + "/api/openapi.json");
  if (!res.ok) ctx.die(`HTTP ${res.status} fetching ${cfg.url}/api/openapi.json`);
  const spec = await res.json();

  if (ctx.flags.json) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }

  const rows = [];
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      rows.push({ method: method.toUpperCase(), path: p, summary: op?.summary ?? "" });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  ctx.out(rows, ctx, ["method", "path", "summary"]);
  console.log(`\n${rows.length} operations. Full spec: nopm openapi --json`);
}
