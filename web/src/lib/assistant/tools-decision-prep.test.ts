/**
 * Decision-prep read tools (B7, R-139): list_change_requests, get_change_request,
 * list_decisions, get_document, get_evm. All GET, all read scopes, no approve/decide path.
 */
import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_SCOPES } from "./tools";
import { MCP_TOOLS } from "../../../mcp/tools.mjs";
import { SUMMARY_COLUMNS, FULL_COLUMNS } from "@/lib/api/views";

const ID = "11111111-1111-4111-8111-111111111111";
const NEW_TOOLS = ["list_change_requests", "get_change_request", "list_decisions", "get_document", "get_evm"] as const;
const tool = (name: string) => TOOLS.find((t) => t.definition.name === name)!;

describe("decision-prep tools are registered on both surfaces", () => {
  for (const name of NEW_TOOLS) {
    it(`${name} is in the assistant set and the MCP set, GET only`, () => {
      expect(tool(name)).toBeDefined();
      expect(MCP_TOOLS.some((t: { name: string }) => t.name === name)).toBe(true);
      expect(tool(name).toRequest({}).method).toBe("GET");
      expect(tool(name).toRequest({ project_id: ID, change_request_id: ID, document_id: ID }).method).toBe("GET");
    });
  }
});

describe("request mapping", () => {
  it("get_evm -> /api/projects/:id/evm", () => {
    expect(tool("get_evm").toRequest({ project_id: ID }).path).toBe(`/api/projects/${ID}/evm`);
  });
  it("get_change_request -> /api/change-requests/:id", () => {
    expect(tool("get_change_request").toRequest({ change_request_id: ID }).path).toBe(`/api/change-requests/${ID}`);
  });
  it("get_document -> /api/documents/:id", () => {
    expect(tool("get_document").toRequest({ document_id: ID }).path).toBe(`/api/documents/${ID}`);
  });
  it("list_change_requests defaults to page 1, limit 20 with no filter", () => {
    expect(tool("list_change_requests").toRequest({}).path).toBe("/api/change-requests?page=1&limit=20");
  });
  it("list_change_requests forwards project_id, status, view and fields", () => {
    const { path } = tool("list_change_requests").toRequest({
      project_id: ID, status: "raised", page: 2, limit: 5, view: "full", fields: "id,title",
    });
    const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(path.startsWith("/api/change-requests?")).toBe(true);
    expect(Object.fromEntries(q)).toEqual({
      page: "2", limit: "5", project_id: ID, status: "raised", view: "full", fields: "id,title",
    });
  });
  it("list_decisions forwards project_id and status", () => {
    const { path } = tool("list_decisions").toRequest({ project_id: ID, status: "accepted" });
    expect(path).toBe(`/api/decisions?page=1&limit=20&project_id=${ID}&status=accepted`);
  });
  it("a non-UUID id is refused before any request is built", () => {
    expect(() => tool("get_evm").toRequest({ project_id: "x/../unlock" })).toThrow(/UUID/);
    expect(() => tool("list_decisions").toRequest({ project_id: "x&y=1" })).toThrow(/UUID/);
  });
  it("a hostile status or fields value cannot add a parameter", () => {
    for (const name of ["list_change_requests", "list_decisions"]) {
      const { path } = tool(name).toRequest({ status: "raised&limit=9999", fields: "id&limit=9999" });
      const keys = [...new URLSearchParams(path.slice(path.indexOf("?") + 1)).keys()].sort();
      expect(keys).toEqual(["fields", "limit", "page", "status"]);
    }
  });
});

describe("lean lists", () => {
  for (const name of ["list_change_requests", "list_decisions"]) {
    it(`${name} advertises view (summary|full) and fields`, () => {
      const props = (tool(name).definition.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.view.enum).toEqual(["summary", "full"]);
      expect(props.fields).toBeDefined();
    });
  }
  it("summary columns are a subset of the allow-list and drop the long text", () => {
    for (const entity of ["change_requests", "decisions"] as const) {
      for (const col of SUMMARY_COLUMNS[entity]) expect(FULL_COLUMNS[entity], col).toContain(col);
    }
    expect(SUMMARY_COLUMNS.change_requests).not.toContain("description");
    expect(SUMMARY_COLUMNS.change_requests).not.toContain("decision_rationale");
    expect(SUMMARY_COLUMNS.decisions).not.toContain("rationale");
    expect(SUMMARY_COLUMNS.decisions).not.toContain("context");
  });
});

describe("least privilege", () => {
  it("TOOL_SCOPES carries the read scopes the new tools need", () => {
    for (const s of ["change:read", "decision:read", "document:read", "budget:read"]) expect(TOOL_SCOPES).toContain(s);
  });
  it("no scope that decides, approves or writes governance records was added", () => {
    const risky = TOOL_SCOPES.filter((s) => /decide|approve|change:write|decision:write|document:write/.test(s));
    expect(risky).toEqual([]);
  });
});
