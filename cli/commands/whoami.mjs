// cli/commands/whoami.mjs — show the current actor + scopes
export const describe = "Show the current actor and their scopes";

export const usage = [
  "nopm whoami                show token identity, role, and scopes",
];

export async function run(_rest, ctx) {
  const { data } = await ctx.api("GET", "/api/me");
  ctx.out(data, ctx, ["type", "id", "label", "workspaceId", "role", "scopes"]);
}
