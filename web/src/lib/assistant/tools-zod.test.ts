/**
 * Agent tools ↔ Zod validator lock test (body-level drift guard).
 *
 * tools-openapi.test.ts locks each tool's {path, method, scope} to the OpenAPI
 * spec — but that never inspected request BODIES, which is how five write
 * tools once shipped advertising field names and enums their endpoints
 * rejected (422 on every call). This test closes that hole: every write
 * tool's advertised JSON Schema is checked directly against the API's real
 * Zod validator via z.toJSONSchema introspection.
 *
 * Per write tool:
 *  (a) every advertised body property exists on the Zod schema;
 *  (b) every Zod-required field is in the tool's required list (route params
 *      like project_id are carried in the URL, not the body, so they're
 *      excluded from the body comparison);
 *  (c) every advertised enum matches the Zod enum EXACTLY (both directions).
 *
 * Also asserts the assistant registry and the MCP server share one registry
 * object — the copy-drift that caused the original bug cannot recur.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOLS } from "./tools";
import { TOOL_REGISTRY } from "../../../mcp/tools.mjs";

import { createProjectSchema, updateProjectSchema } from "@/app/api/projects/_schema";
import { createMilestoneSchema, updateMilestoneSchema } from "@/app/api/milestones/_schema";
import {
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskDeleteRequestSchema,
} from "@/app/api/tasks/_schema";
import { createRiskSchema, updateRiskSchema } from "@/app/api/risks/_schema";
import { createIssueSchema, updateIssueSchema } from "@/app/api/issues/_schema";

// ---------------------------------------------------------------------------
// Tool → validator map. `routeParams` are tool args consumed by the URL
// template (toRequest strips them from the body).
// ---------------------------------------------------------------------------

const WRITE_TOOL_VALIDATORS: Record<
  string,
  { schema: z.ZodType; routeParams: string[] }
> = {
  create_project: { schema: createProjectSchema, routeParams: [] },
  update_project: { schema: updateProjectSchema, routeParams: ["project_id"] },
  create_milestone: { schema: createMilestoneSchema, routeParams: ["project_id"] },
  update_milestone: { schema: updateMilestoneSchema, routeParams: ["milestone_id"] },
  create_task: { schema: TaskCreateSchema, routeParams: ["project_id"] },
  update_task: { schema: TaskUpdateSchema, routeParams: ["task_id"] },
  request_task_deletion: { schema: TaskDeleteRequestSchema, routeParams: ["task_id"] },
  create_risk: { schema: createRiskSchema, routeParams: ["project_id"] },
  update_risk: { schema: updateRiskSchema, routeParams: ["risk_id"] },
  create_issue: { schema: createIssueSchema, routeParams: ["project_id"] },
  update_issue: { schema: updateIssueSchema, routeParams: ["issue_id"] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  [key: string]: unknown;
};

/** Introspect a Zod schema as an input-side JSON Schema (defaults → optional). */
function zodToInputSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
}

/** Dig an enum out of a property schema, unwrapping anyOf (nullable unions). */
function extractEnum(prop: JsonSchema | undefined): unknown[] | null {
  if (!prop) return null;
  if (Array.isArray(prop.enum)) return prop.enum;
  for (const variant of prop.anyOf ?? []) {
    const found = extractEnum(variant);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry identity — assistant and MCP consume the SAME objects
// ---------------------------------------------------------------------------

describe("Registry identity — assistant tools ARE the MCP registry", () => {
  it("TOOLS is a 1:1 view over TOOL_REGISTRY (same names, same order)", () => {
    expect(TOOLS.map((t) => t.definition.name)).toEqual(TOOL_REGISTRY.map((t) => t.name));
  });

  it("parameters objects are shared by reference (no copies to drift)", () => {
    for (let i = 0; i < TOOLS.length; i++) {
      expect(TOOLS[i].definition.parameters).toBe(TOOL_REGISTRY[i].parameters);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage — every write tool in the registry has a validator mapping here
// ---------------------------------------------------------------------------

describe("Coverage — every write tool is locked to a Zod validator", () => {
  const writeTools = TOOLS.filter((t) => t.toRequest({}).method !== "GET");

  it("no write tool is missing from WRITE_TOOL_VALIDATORS", () => {
    const unmapped = writeTools
      .map((t) => t.definition.name)
      .filter((name) => !(name in WRITE_TOOL_VALIDATORS));
    expect(
      unmapped,
      `Write tools without a Zod lock: [${unmapped.join(", ")}] — add them to WRITE_TOOL_VALIDATORS`,
    ).toHaveLength(0);
  });

  it("no validator mapping points at a tool that no longer exists", () => {
    const names = new Set(TOOLS.map((t) => t.definition.name));
    for (const mapped of Object.keys(WRITE_TOOL_VALIDATORS)) {
      expect(names.has(mapped), `WRITE_TOOL_VALIDATORS has stale entry "${mapped}"`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (a)(b)(c) — per-tool body checks against the real validator
// ---------------------------------------------------------------------------

describe("Body drift guard — tool schemas match the Zod validators", () => {
  for (const [toolName, { schema, routeParams }] of Object.entries(WRITE_TOOL_VALIDATORS)) {
    const tool = TOOLS.find((t) => t.definition.name === toolName);
    if (!tool) continue; // stale mapping is caught by the coverage test above

    const params = tool.definition.parameters as JsonSchema;
    const toolProps = params.properties ?? {};
    const toolRequired = new Set(params.required ?? []);
    const zodSchema = zodToInputSchema(schema);
    const zodProps = zodSchema.properties ?? {};
    const zodRequired = zodSchema.required ?? [];

    describe(toolName, () => {
      it("(a) every advertised body property exists on the Zod schema", () => {
        for (const prop of Object.keys(toolProps)) {
          if (routeParams.includes(prop)) continue;
          expect(
            prop in zodProps,
            `Tool "${toolName}" advertises "${prop}" but the validator has no such field — ` +
              `Zod strips it silently or the endpoint 422s`,
          ).toBe(true);
        }
      });

      it("(b) every Zod-required field is required by the tool", () => {
        for (const field of zodRequired) {
          expect(
            toolRequired.has(field),
            `Validator REQUIRES "${field}" but tool "${toolName}" doesn't require it — ` +
              `models will omit it and get a guaranteed 422`,
          ).toBe(true);
        }
      });

      it("(c) every advertised enum matches the Zod enum exactly", () => {
        for (const [prop, propSchema] of Object.entries(toolProps)) {
          if (routeParams.includes(prop)) continue;
          const toolEnum = extractEnum(propSchema);
          if (!toolEnum) continue;
          const zodEnum = extractEnum(zodProps[prop]);
          expect(
            zodEnum,
            `Tool "${toolName}" advertises an enum for "${prop}" but the validator has none`,
          ).not.toBeNull();
          expect(
            [...toolEnum].sort(),
            `Tool "${toolName}" enum for "${prop}" drifted from the validator`,
          ).toEqual([...(zodEnum as unknown[])].sort());
        }
      });
    });
  }
});
