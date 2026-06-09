import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard test for the most dangerous silent-failure mode in NoPM:
 *
 * Token/agent callers use the service-role admin client (createAdminClient),
 * which BYPASSES RLS. Workspace isolation then depends entirely on every handler
 * remembering to scope its queries — by workspace (actor.workspaceId) or, for
 * per-user surfaces, by the caller's identity. A single route that calls the
 * admin client without ANY scoping token would leak cross-tenant/other-user data
 * with no DB-level catch.
 *
 * This test fails the build if any API route uses the admin client but contains
 * no recognizable scoping reference. It is a backstop, not a proof — but it
 * turns "we rely on discipline" into "a missed scope breaks CI".
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

// Tokens that indicate a handler scopes its admin-client queries to a tenant
// (workspace) or to the calling user. A route using the admin client must
// reference at least one of these.
const SCOPING_TOKENS = [
  "workspace_id",
  "workspaceId",
  "actor.id",
  "user.id",
  "user_id",
  "recipient_id",
  "profile_id",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}

describe("workspace isolation (admin-client scoping)", () => {
  const routes = walk(API_DIR);

  it("finds the API route files", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("every admin-client route scopes by workspace or caller identity", () => {
    const adminRoutes = routes.filter((f) => readFileSync(f, "utf8").includes("createAdminClient"));
    expect(adminRoutes.length).toBeGreaterThan(20); // sanity: most routes use it

    const unscoped = adminRoutes.filter((f) => {
      const src = readFileSync(f, "utf8");
      return !SCOPING_TOKENS.some((t) => src.includes(t));
    });

    // Helpful failure output: list any offending route paths.
    expect(unscoped.map((f) => f.replace(API_DIR, "api"))).toEqual([]);
  });
});
