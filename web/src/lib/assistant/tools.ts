/**
 * Curated tool set for the NoPM assistant.
 *
 * The registry itself lives in web/mcp/tools.mjs — ONE file shared verbatim
 * with the MCP server, so the two agent surfaces cannot drift apart. This
 * module re-exports it in the shape the assistant loop expects and pins the
 * least-privilege scope ceiling for the ephemeral token.
 *
 * Field names / enums are locked to the API's Zod validators by
 * tools-zod.test.ts; path+method+scope are locked to the OpenAPI spec by
 * tools-openapi.test.ts.
 */

import type { ToolDefinition } from "./providers/openai";
import { TOOL_REGISTRY } from "../../../mcp/tools.mjs";

/** Tool registry entry — schema + the HTTP call the executor makes. */
export type ToolSpec = {
  definition: ToolDefinition;
  /** Build the fetch call. Returns [url_path, method, body?] */
  toRequest: (args: Record<string, unknown>) => {
    path: string;      // e.g. "/api/projects"
    method: string;    // "GET" | "POST" | "PATCH" | "DELETE"
    body?: unknown;
  };
};

export const TOOLS: ToolSpec[] = TOOL_REGISTRY.map((t) => ({
  definition: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
  toRequest: t.toRequest,
}));

/** The exact scopes this tool set requires on the ephemeral token. */
export const TOOL_SCOPES = [
  "project:read",
  "project:write",
  "milestone:read",
  "milestone:write",
  "task:read",
  "task:write",
  "task:delete:request",
  "project:delete:request",
  "risk:read",
  "risk:write",
  "issue:read",
  "issue:write",
  "budget:read",
  "clash:read",
  "resource:read",
  "audit:read",
] as const;

export type ToolScope = (typeof TOOL_SCOPES)[number];
