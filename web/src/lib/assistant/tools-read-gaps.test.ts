/**
 * R-187: the read-only id finders and inbox tools, and the tools/list size budget (M3).
 */
import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, MCP_TOOLS, ToolArgError } from "../../../mcp/tools.mjs";
import { toMcpTool } from "../../../mcp/shared.mjs";
import { TOOL_SCOPES } from "./tools";

const UUID = "11111111-1111-4111-8111-111111111111";
const NEW_TOOLS = ["list_workspace_tasks", "list_sprints", "list_programs", "list_expenses", "list_allocations", "list_notifications"];

const tool = (n: string) => TOOL_REGISTRY.find((t: { name: string }) => t.name === n)!;

describe("read-only tool gaps (R-187)", () => {
  it("adds only GET tools, in the assistant registry and the MCP list", () => {
    for (const n of NEW_TOOLS) {
      expect(tool(n), n).toBeDefined();
      expect(tool(n).toRequest({}).method).toBe("GET");
      expect(MCP_TOOLS.some((t: { name: string }) => t.name === n)).toBe(true);
    }
  });

  it("the scope ceiling gained read scopes only", () => {
    for (const s of ["sprint:read", "program:read", "notification:read"]) expect(TOOL_SCOPES).toContain(s);
    const privileged = TOOL_SCOPES.filter((s) => /:(approve|decide|admin)$|:delete:approve$|^token|^member/.test(s));
    expect(privileged).toEqual([]);
    // write scopes are exactly the ones the assistant already held before this change
    const writes = TOOL_SCOPES.filter((s) => s.endsWith(":write")).sort();
    expect(writes).toEqual(["issue:write", "milestone:write", "project:write", "risk:write", "task:write"]);
  });

  it("list_workspace_tasks builds the my-work, overdue and due-soon queries", () => {
    const t = tool("list_workspace_tasks");
    const mine = t.toRequest({ assignee_id: "me", overdue: true });
    expect(mine.path).toMatch(/^\/api\/tasks\?/);
    expect(mine.path).toContain("assignee_id=me");
    expect(mine.path).toContain("overdue=true");
    const soon = t.toRequest({ assignee_id: "me", due_after: "2026-11-03", due_before: "2026-11-10", sort: "due_date:asc" });
    expect(soon.path).toContain("due_before=2026-11-10");
    expect(soon.path).toContain("sort=due_date%3Aasc");
  });

  it("list_workspace_tasks refuses a hostile assignee or project id", () => {
    const t = tool("list_workspace_tasks");
    expect(() => t.toRequest({ assignee_id: "../x" })).toThrow(ToolArgError);
    expect(() => t.toRequest({ assignee_id: "me&limit=999" })).toThrow(ToolArgError);
    expect(() => t.toRequest({ project_id: "x&overdue=true" })).toThrow(ToolArgError);
    expect(t.toRequest({ assignee_id: UUID }).path).toContain(`assignee_id=${UUID}`);
  });

  it("list_sprints and list_expenses refuse a hostile project id", () => {
    expect(() => tool("list_sprints").toRequest({ project_id: "../x" })).toThrow(ToolArgError);
    expect(() => tool("list_expenses").toRequest({ project_id: "../x" })).toThrow(ToolArgError);
    expect(tool("list_sprints").toRequest({ project_id: UUID, state: "active" }).path).toContain("state=active");
    expect(tool("list_expenses").toRequest({ project_id: UUID }).path).toBe(`/api/projects/${UUID}/expenses?page=1&limit=20`);
  });

  it("list_notifications asks for unread only on request", () => {
    expect(tool("list_notifications").toRequest({}).path).not.toContain("unread");
    expect(tool("list_notifications").toRequest({ unread_only: true }).path).toContain("unread=1");
  });

  it("every deletion-request tool has a list tool that its description names", () => {
    const pairs: Record<string, string> = {
      request_expense_deletion: "list_expenses",
      request_sprint_deletion: "list_sprints",
      request_program_deletion: "list_programs",
      request_allocation_deletion: "list_allocations",
    };
    for (const [req, list] of Object.entries(pairs)) {
      expect(tool(req).description, req).toContain(list);
      expect(tool(list), list).toBeDefined();
    }
  });
});

describe("tools/list size budget (M3)", () => {
  const listBytes = (tools: { name: string }[]) => JSON.stringify(tools.map(toMcpTool)).length;

  // 58,000 chars is about 5% above the size after the A7 trim (about 55.8 KB for 62 tools, down
  // from 67.2 KB with the same tools). A new tool or a longer description has to fit, or trim another.
  it("MCP tools/list stays under 58,000 characters", () => {
    expect(listBytes(MCP_TOOLS)).toBeLessThan(58_000);
  });

  it("the assistant's per-step tool definitions stay under 42,000 characters", () => {
    const defs = TOOL_REGISTRY.map((t: { name: string; description: string; parameters: unknown }) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    expect(JSON.stringify(defs).length).toBeLessThan(42_000);
  });

  it("no description runs past 620 characters", () => {
    for (const t of MCP_TOOLS as { name: string; description: string }[]) {
      expect(t.description.length, t.name).toBeLessThanOrEqual(620);
    }
  });

  it("the weak descriptions now say when to use the tool and where ids come from", () => {
    expect(tool("create_milestone").description).toMatch(/Needs project_id/);
    expect(tool("list_clashes").description).toMatch(/clash id/);
    expect(tool("list_resources").description).toMatch(/member id/);
    expect(tool("get_project").description).toMatch(/list_projects/);
    expect(tool("list_rebaselines").description).toMatch(/get_baseline_history/);
  });
});
