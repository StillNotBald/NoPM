/**
 * Assistant tools ↔ OpenAPI spec lock test.
 *
 * Three safety assertions:
 *
 * (a) DRIFT GUARD — every assistant tool's { path, method } is documented in
 *     the OpenAPI spec.  Paths with concrete UUIDs are normalised back to their
 *     {id}-style template form so they match spec keys.
 *
 * (b) SCOPE CONTAINMENT — every scope that the OpenAPI spec ascribes to a
 *     tool's endpoint is present in TOOL_SCOPES (least-privilege).
 *
 * (c) GOVERNANCE HARD LIMITS — TOOL_SCOPES explicitly excludes the four-eyes
 *     / admin scopes: task:delete:approve, rebaseline:approve, every
 *     token:* / token scope, and the bare "*" wildcard.
 */

import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_SCOPES } from "./tools";
import { specForTesting as spec } from "@/app/api/openapi.json/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip query-string and normalise concrete UUID path segments back to the
 * OpenAPI {id} template form.
 *
 * e.g.  /api/projects/550e8400-e29b-41d4-a716-446655440000/milestones?page=1
 *    →  /projects/{id}/milestones
 *
 * The tools build paths under /api/... but the spec keys are relative to the
 * server base, so we also strip the leading /api prefix.
 */
function normalisePath(rawPath: string): string {
  // Drop query string
  const withoutQs = rawPath.split("?")[0];

  // Strip /api prefix (the spec paths are relative to the /api server base)
  const withoutApiPrefix = withoutQs.replace(/^\/api/, "");

  // Replace UUID-looking segments with {id}
  const uuidPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  return withoutApiPrefix.replace(uuidPattern, "{id}");
}

/**
 * Representative args — supply enough for toRequest() to produce a concrete path.
 * Uses a stable fake UUID that won't collide with real data.
 */
const FAKE_UUID = "00000000-0000-4000-a000-000000000001";

const REPRESENTATIVE_ARGS: Record<string, Record<string, unknown>> = {
  list_projects:        { page: 1, limit: 20 },
  get_project:          { project_id: FAKE_UUID },
  create_project:       { code: "T1", name: "Test" },
  update_project:       { project_id: FAKE_UUID, name: "Test" },
  list_milestones:      { project_id: FAKE_UUID },
  create_milestone:     { project_id: FAKE_UUID, name: "M1" },
  update_milestone:     { milestone_id: FAKE_UUID, status: "on_track" },
  list_tasks:           { project_id: FAKE_UUID },
  get_task:             { task_id: FAKE_UUID },
  create_task:          { project_id: FAKE_UUID, name: "T1" },
  update_task:          { task_id: FAKE_UUID, status_type: "started" },
  request_task_deletion:{ task_id: FAKE_UUID, reason: "test cleanup" },
  list_risks:           { project_id: FAKE_UUID },
  create_risk:          { project_id: FAKE_UUID, title: "R1", severity: "low", likelihood: "low" },
  update_risk:          { risk_id: FAKE_UUID, status: "mitigating" },
  list_issues:          { project_id: FAKE_UUID },
  create_issue:         { project_id: FAKE_UUID, title: "I1", priority: "low" },
  update_issue:         { issue_id: FAKE_UUID, status: "resolved" },
  get_budget:           { project_id: FAKE_UUID },
  list_clashes:         {},
  list_resources:       {},
  search_workspace:     { query: "kanban" },
  query_audit:          {},
};

// Typed view of the spec paths for easier narrowing
const specPaths = spec.paths as Record<string, Record<string, { description?: string }>>;

/**
 * Extract the documented scope from an OpenAPI operation description.
 *
 * Operation descriptions follow the pattern:  "scope: <scope_value>. ..."
 * Some operations have multiple accepted scopes separated by " or ".
 *
 * Returns [] when the operation has no "scope:" annotation (public/session-only
 * endpoints), which the assistant never calls anyway.
 */
function extractSpecScopes(description: string | undefined): string[] {
  if (!description) return [];
  // Match "scope: task:delete:request" or "scope: task:read or audit:read"
  const match = description.match(/scope:\s*([^.]+)/i);
  if (!match) return [];
  return match[1]
    .split(/\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Flat array for membership checks
const toolScopesArray: string[] = [...TOOL_SCOPES];

// ---------------------------------------------------------------------------
// (a) Drift guard — every tool's path+method is in the spec
// ---------------------------------------------------------------------------

describe("(a) Drift guard — every assistant tool maps to a documented OpenAPI endpoint", () => {
  for (const tool of TOOLS) {
    const name = tool.definition.name;
    const args = REPRESENTATIVE_ARGS[name] ?? {};

    it(`${name}: path+method exists in spec`, () => {
      const req = tool.toRequest(args);
      const normPath = normalisePath(req.path);
      const method = req.method.toLowerCase();

      const pathItem = specPaths[normPath];
      expect(
        pathItem,
        `Tool "${name}" requests ${req.method} ${req.path} which normalises to "${normPath}" — path is NOT documented in the OpenAPI spec`,
      ).toBeDefined();

      const operation = pathItem[method];
      expect(
        operation,
        `Tool "${name}" requests ${req.method.toUpperCase()} ${normPath} — method is NOT documented in the OpenAPI spec for this path`,
      ).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// (b) Scope containment — the scope documented in the spec for each tool's
//     endpoint must be present in TOOL_SCOPES.
// ---------------------------------------------------------------------------

describe("(b) Scope containment — every endpoint scope is within TOOL_SCOPES", () => {
  for (const tool of TOOLS) {
    const name = tool.definition.name;
    const args = REPRESENTATIVE_ARGS[name] ?? {};

    it(`${name}: spec scope(s) are covered by TOOL_SCOPES`, () => {
      const req = tool.toRequest(args);
      const normPath = normalisePath(req.path);
      const method = req.method.toLowerCase();

      const pathItem = specPaths[normPath];
      // Path must exist (already asserted in section (a), but guard here too)
      expect(pathItem, `Path "${normPath}" not in spec`).toBeDefined();

      const operation = pathItem[method];
      expect(operation, `Method "${method}" not in spec for "${normPath}"`).toBeDefined();

      const specScopes = extractSpecScopes(operation.description);

      // If the spec documents scopes for this endpoint, at least one must be in
      // TOOL_SCOPES (the assistant token must hold a scope that satisfies the
      // endpoint's requirement).
      if (specScopes.length > 0) {
        const covered = specScopes.some((s) => toolScopesArray.includes(s));
        expect(
          covered,
          `Tool "${name}" (${method.toUpperCase()} ${normPath}) requires one of [${specScopes.join(", ")}] ` +
          `but none of those scopes are in TOOL_SCOPES`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (c) Governance hard limits — forbidden scopes must NOT appear in TOOL_SCOPES
// ---------------------------------------------------------------------------

describe("(c) Governance hard limits — TOOL_SCOPES excludes privileged/admin scopes", () => {
  it('TOOL_SCOPES does NOT contain task:delete:approve (checker role must never be held by the assistant)', () => {
    expect(toolScopesArray).not.toContain("task:delete:approve");
  });

  it('TOOL_SCOPES does NOT contain rebaseline:approve (four-eyes; assistant cannot unilaterally rebaseline)', () => {
    expect(toolScopesArray).not.toContain("rebaseline:approve");
  });

  it('TOOL_SCOPES does NOT contain any token:* scope (privilege escalation guard)', () => {
    const tokenScopes = toolScopesArray.filter((s) => s.startsWith("token:") || s === "token");
    expect(
      tokenScopes,
      `Found token scopes in TOOL_SCOPES: [${tokenScopes.join(", ")}]`,
    ).toHaveLength(0);
  });

  it('TOOL_SCOPES does NOT contain the bare "*" wildcard (no omnipotence grant)', () => {
    expect(toolScopesArray).not.toContain("*");
  });

  // Belt-and-suspenders: confirm no ":*" resource-wildcard either
  it('TOOL_SCOPES does NOT contain any resource-level wildcard (e.g. task:*)', () => {
    const wildcards = toolScopesArray.filter((s) => s.endsWith(":*"));
    expect(
      wildcards,
      `Found wildcard scopes in TOOL_SCOPES: [${wildcards.join(", ")}]`,
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sanity — TOOL_SCOPES itself is a non-empty array of known concrete scopes
// ---------------------------------------------------------------------------

describe("Sanity — TOOL_SCOPES is well-formed", () => {
  it("is non-empty", () => {
    expect(toolScopesArray.length).toBeGreaterThan(0);
  });

  it("contains only strings", () => {
    for (const s of toolScopesArray) {
      expect(typeof s).toBe("string");
    }
  });

  it("has no duplicate entries", () => {
    const unique = new Set(toolScopesArray);
    expect(unique.size).toBe(toolScopesArray.length);
  });
});
