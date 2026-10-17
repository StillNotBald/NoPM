/**
 * MCP-only governance tools (change request, rebaseline propose / sign-off /
 * apply, timesheet submit, decision, document) — locked to the OpenAPI spec and
 * the Zod validators, and locked OUT of the in-app assistant.
 */

import { describe, it, expect } from "vitest";
import { MCP_GOVERNANCE_TOOLS, MCP_TOOLS, TOOL_REGISTRY, ToolArgError } from "../../../mcp/tools.mjs";
import { TOOLS, TOOL_SCOPES } from "./tools";
import { specForTesting as spec } from "@/app/api/openapi.json/route";
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";
import { createRebaselineSchema, signoffSchema } from "@/app/api/rebaselines/_schema";
import { createTimesheetSubmissionSchema } from "@/app/api/timesheet-submissions/_schema";
import { createDecisionSchema } from "@/app/api/decisions/_schema";
import { createDocumentSchema } from "@/app/api/documents/_schema";

const ID = "00000000-0000-4000-a000-000000000001";
const specPaths = spec.paths as Record<string, Record<string, { description?: string }>>;

const ARGS: Record<string, Record<string, unknown>> = {
  create_change_request: { project_id: ID, title: "Move go-live", category: "schedule", priority: "high", impact_schedule_days: 5 },
  propose_rebaseline: { project_id: ID, reason: "Vendor slipped" },
  sign_off_rebaseline: { rebaseline_id: ID, vote: "go", comment: "ok" },
  apply_rebaseline: { rebaseline_id: ID },
  submit_timesheet: { member_id: ID, period_start: "2026-10-12" },
  create_decision: { project_id: ID, title: "Use vendor A", status: "accepted" },
  create_document: { title: "Kickoff notes", doc_type: "minutes" },
};

const SCOPE: Record<string, string> = {
  create_change_request: "change:write",
  propose_rebaseline: "project:write",
  sign_off_rebaseline: "rebaseline:approve",
  apply_rebaseline: "rebaseline:approve",
  submit_timesheet: "time:submit",
  create_decision: "decision:write",
  create_document: "document:write",
};

function norm(p: string): string {
  return p
    .split("?")[0]
    .replace(/^\/api/, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{id}");
}

describe("MCP governance tools", () => {
  it("covers exactly the seven expected tools", () => {
    expect(MCP_GOVERNANCE_TOOLS.map((t: { name: string }) => t.name).sort()).toEqual(Object.keys(ARGS).sort());
  });

  it("MCP_TOOLS = shared registry + governance tools, names unique", () => {
    expect(MCP_TOOLS.length).toBe(TOOL_REGISTRY.length + MCP_GOVERNANCE_TOOLS.length);
    const names = MCP_TOOLS.map((t: { name: string }) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const tool of MCP_GOVERNANCE_TOOLS as Array<{ name: string; toRequest: (a: Record<string, unknown>) => { path: string; method: string; body?: unknown } }>) {
    it(`${tool.name}: path+method and scope are documented in the spec`, () => {
      const req = tool.toRequest(ARGS[tool.name]);
      const op = specPaths[norm(req.path)]?.[req.method.toLowerCase()];
      expect(op, `${req.method} ${norm(req.path)} not in spec`).toBeDefined();
      expect(op!.description ?? "").toContain(`scope: ${SCOPE[tool.name]}`);
    });

    it(`${tool.name}: rejects a path-traversal id`, () => {
      const idKey = Object.keys(ARGS[tool.name]).find((k) => k.endsWith("_id") && k !== "member_id");
      if (!idKey) return;
      expect(() => tool.toRequest({ ...ARGS[tool.name], [idKey]: `${ID}/../unlock?x=` })).toThrow(ToolArgError);
    });

    it(`${tool.name}: tolerates empty args (probe)`, () => {
      expect(() => tool.toRequest({})).not.toThrow();
    });
  }

  it("request bodies satisfy the API's Zod validators", () => {
    const body = (n: string) => (MCP_GOVERNANCE_TOOLS as Array<{ name: string; toRequest: (a: Record<string, unknown>) => { body?: unknown } }>).find((t) => t.name === n)!.toRequest(ARGS[n]).body;
    expect(createChangeRequestSchema.safeParse(body("create_change_request")).success).toBe(true);
    expect(createRebaselineSchema.safeParse(body("propose_rebaseline")).success).toBe(true);
    expect(signoffSchema.safeParse(body("sign_off_rebaseline")).success).toBe(true);
    expect(createTimesheetSubmissionSchema.safeParse(body("submit_timesheet")).success).toBe(true);
    expect(createDecisionSchema.safeParse(body("create_decision")).success).toBe(true);
    expect(createDocumentSchema.safeParse(body("create_document")).success).toBe(true);
  });

  it("the in-app assistant gets NONE of them and its scope ceiling has no approve scope", () => {
    const assistantNames = TOOLS.map((t) => t.definition.name);
    for (const t of MCP_GOVERNANCE_TOOLS as Array<{ name: string }>) expect(assistantNames).not.toContain(t.name);
    expect(TOOL_SCOPES as readonly string[]).not.toContain("rebaseline:approve");
  });

  it("approve tools describe the manager/admin rule so an agent does not retry a 403", () => {
    for (const n of ["sign_off_rebaseline", "apply_rebaseline"]) {
      const t = (MCP_GOVERNANCE_TOOLS as Array<{ name: string; description: string }>).find((x) => x.name === n)!;
      expect(t.description).toMatch(/admin or manager/);
    }
  });
});
