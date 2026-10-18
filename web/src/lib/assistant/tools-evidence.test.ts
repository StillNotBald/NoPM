/**
 * W5-F (R-171 to R-173): MCP evidence, implement and decision-prep tools.
 * One check per tool for method, path, body and scope text; zod agreement; path safety; lean-default reads.
 */
import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_SCOPES } from "./tools";
import { MCP_GOVERNANCE_TOOLS, MCP_TOOLS, TOOL_REGISTRY, ToolArgError } from "../../../mcp/tools.mjs";
import { createDocumentSchema } from "@/app/api/documents/_schema";
import { createDecisionSchema } from "@/app/api/decisions/_schema";
import { TaskCreateSchema, TaskUpdateSchema } from "@/app/api/tasks/_schema";
import { attachEvidenceSchema } from "@/app/api/change-requests/[id]/evidence/_schema";
import { specForTesting as spec } from "@/app/api/openapi.json/route";

type Tool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, { enum?: string[] }>; required: string[] };
  toRequest: (a: Record<string, unknown>) => { path: string; method: string; body?: unknown };
};
const find = (name: string): Tool => (MCP_TOOLS as Tool[]).find((t) => t.name === name)!;
const ID = "11111111-1111-4111-8111-111111111111";
const CR = "22222222-2222-4222-8222-222222222222";

describe("attach_evidence", () => {
  const t = find("attach_evidence");
  it("is an MCP governance tool, never given to the in-app assistant", () => {
    expect((MCP_GOVERNANCE_TOOLS as Tool[]).some((x) => x.name === "attach_evidence")).toBe(true);
    expect(TOOLS.some((x) => x.definition.name === "attach_evidence")).toBe(false);
  });
  it("POSTs to the evidence route with the change request in the path and the rest in the body", () => {
    const req = t.toRequest({ change_request_id: CR, title: "Run", evidence_type: "test_result", evidence_result: "pass", tested_by: "QA" });
    expect(req.method).toBe("POST");
    expect(req.path).toBe(`/api/change-requests/${CR}/evidence`);
    expect(req.body).toEqual({ title: "Run", evidence_type: "test_result", evidence_result: "pass", tested_by: "QA" });
  });
  it("links an existing document through document_id", () => {
    const req = t.toRequest({ change_request_id: CR, document_id: ID, evidence_type: "uat_signoff" });
    expect(attachEvidenceSchema.safeParse(req.body).success).toBe(true);
  });
  it("states the write scope and no approve or decide scope", () => {
    expect(t.description).toContain("scope: document:write");
    expect(t.description).not.toMatch(/scope: [^.]*(decide|approve)/);
  });
  it("requires the change request and the evidence type; enums match the validators", () => {
    expect(t.parameters.required).toEqual(["change_request_id", "evidence_type"]);
    expect(t.parameters.properties.evidence_type.enum).toEqual(["test_result", "uat_signoff", "deploy_record", "screenshot", "other"]);
    expect(t.parameters.properties.evidence_result.enum).toEqual(["pass", "fail", "partial", "n/a"]);
  });
  it("refuses a path-traversal id and tolerates empty args", () => {
    expect(() => t.toRequest({ change_request_id: `${CR}/../decision`, evidence_type: "other" })).toThrow(ToolArgError);
    expect(() => t.toRequest({})).not.toThrow();
  });
});

describe("implement_change_request", () => {
  const t = find("implement_change_request");
  it("POSTs to the implement route with the optional note", () => {
    const req = t.toRequest({ change_request_id: CR, note: "Live" });
    expect(req).toEqual({ path: `/api/change-requests/${CR}/implement`, method: "POST", body: { note: "Live" } });
  });
  it("uses change:write, never change:decide, and states the date check", () => {
    expect(t.description).toContain("scope: change:write");
    expect(t.description).toContain("not change:decide");
    expect(t.description).toContain("implemented_at earlier than decided_at");
  });
  it("is not offered to the in-app assistant and its ceiling holds no decide scope", () => {
    expect(TOOLS.some((x) => x.definition.name === "implement_change_request")).toBe(false);
    expect(TOOL_SCOPES as readonly string[]).not.toContain("change:decide");
    expect(TOOL_SCOPES as readonly string[]).not.toContain("document:write");
  });
  it("refuses a path-traversal id", () => {
    expect(() => t.toRequest({ change_request_id: `${CR}/../decision` })).toThrow(ToolArgError);
  });
});

describe("create_document and create_decision gain their link fields", () => {
  it("create_document passes the evidence fields through to a body the API accepts", () => {
    const body = find("create_document").toRequest({
      title: "Run", doc_type: "other", project_id: ID, change_request_id: CR, evidence_type: "test_result", evidence_result: "pass",
      tested_by_label: "QA", tested_at: "2026-10-18T10:00:00Z", evidence_note: "ok",
    }).body;
    expect(createDocumentSchema.safeParse(body).success).toBe(true);
  });
  it("create_decision passes change_request_id into the project's decisions route", () => {
    const req = find("create_decision").toRequest({ project_id: ID, title: "Go", change_request_id: CR });
    expect(req.path).toBe(`/api/projects/${ID}/decisions`);
    expect(req.body).toEqual({ title: "Go", change_request_id: CR });
    expect(createDecisionSchema.safeParse(req.body).success).toBe(true);
  });
  it("create_task and update_task carry blocker_reason and eta (and null clears)", () => {
    const c = find("create_task").toRequest({ project_id: ID, name: "T", blocker_reason: "Waiting on vendor", eta: "2026-11-01" }).body;
    expect(TaskCreateSchema.safeParse(c).success).toBe(true);
    const u = find("update_task").toRequest({ task_id: ID, blocker_reason: null, eta: null }).body;
    expect(TaskUpdateSchema.safeParse(u).success).toBe(true);
    expect(u).toEqual({ blocker_reason: null, eta: null });
  });
  it("get_change_request points at the evidence route; create_change_request words the emergency path", () => {
    expect(find("get_change_request").description).toContain("evidence route");
    const d = find("create_change_request").description;
    expect(d).toContain("change:decide");
    expect(d).toContain("commits as soon as it is raised");
  });
});

describe("decision-prep reads", () => {
  const READS = ["list_documents", "list_rebaselines", "get_baseline_history", "list_project_dependencies"];
  it("are in both registries as GET with a read scope the assistant already holds", () => {
    for (const n of READS) {
      expect(TOOL_REGISTRY.some((x) => x.name === n), n).toBe(true);
      expect(TOOLS.some((x) => x.definition.name === n), n).toBe(true);
      expect(find(n).toRequest({}).method).toBe("GET");
    }
    for (const s of ["document:read", "project:read"]) expect(TOOL_SCOPES as readonly string[]).toContain(s);
  });
  it("map to the existing routes", () => {
    expect(find("list_rebaselines").toRequest({ project_id: ID }).path).toBe(`/api/projects/${ID}/rebaselines?page=1&limit=20`);
    expect(find("get_baseline_history").toRequest({ project_id: ID }).path).toBe(`/api/projects/${ID}/rebaselines?page=1&limit=100`);
    expect(find("list_project_dependencies").toRequest({ project_id: ID }).path).toBe(`/api/projects/${ID}/dependencies`);
    expect(find("list_documents").toRequest({}).path).toBe("/api/documents?page=1&limit=20");
  });
  it("list_documents forwards its filters, view and fields", () => {
    const { path } = find("list_documents").toRequest({
      project_id: ID, change_request_id: CR, status: "draft", doc_type: "other", folder: "QA", page: 2, limit: 5, view: "full", fields: "id,title",
    });
    expect(Object.fromEntries(new URLSearchParams(path.slice(path.indexOf("?") + 1)))).toEqual({
      page: "2", limit: "5", project_id: ID, change_request_id: CR, status: "draft", doc_type: "other", folder: "QA", view: "full", fields: "id,title",
    });
  });
  it("list_documents is lean by default: it sends no view, so the route's summary default applies, and advertises summary|full", () => {
    expect(find("list_documents").toRequest({}).path).not.toContain("view=");
    expect(find("list_documents").parameters.properties.view.enum).toEqual(["summary", "full"]);
    expect(find("list_documents").description).toContain("lean");
  });
  it("a hostile id or filter cannot add a parameter or change the route", () => {
    expect(() => find("list_documents").toRequest({ change_request_id: `${CR}&limit=999` })).toThrow(ToolArgError);
    expect(() => find("list_rebaselines").toRequest({ project_id: `${ID}/../unlock` })).toThrow(ToolArgError);
    const { path } = find("list_documents").toRequest({ status: "draft&limit=9999", folder: "a&b=1" });
    expect([...new URLSearchParams(path.slice(path.indexOf("?") + 1)).keys()].sort()).toEqual(["folder", "limit", "page", "status"]);
  });
  it("their endpoints are documented in the OpenAPI spec with the scope the tool states", () => {
    const paths = spec.paths as Record<string, Record<string, { description?: string }>>;
    expect(paths["/documents"].get.description).toContain("scope: document:read");
    expect(paths["/projects/{id}/rebaselines"].get.description).toContain("scope: project:read");
    expect(paths["/projects/{id}/dependencies"].get.description).toContain("scope: project:read");
    expect(paths["/change-requests/{id}/implement"].post.description).toContain("scope: change:write");
  });
});
