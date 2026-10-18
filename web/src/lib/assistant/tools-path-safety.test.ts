/**
 * Agent-tool path safety (R1 M4).
 *
 * The tool registry (web/mcp/tools.mjs) is shared by the MCP server, the
 * /api/mcp HTTP endpoint and the in-app assistant. Tool arguments are
 * model-controlled text, and ids used to be interpolated into the request path
 * unchecked: a `project_id` of "<uuid>/../unlock?x=" steered create_milestone
 * to POST /api/projects/<uuid>/unlock — a route that is not a tool.
 *
 *  1. every id that lands in a path must be a UUID, else ToolArgError is thrown
 *     BEFORE any request exists (so nothing can be fetched);
 *  2. page / limit are encoded, so they can only ever be a query value;
 *  3. a second layer pins each built request to its own tool's route shape;
 *  4. toRequest({}) still never throws (fallback.ts probes it at import time);
 *  5. end to end through /api/mcp: a hostile id yields a "Bad arguments" tool
 *     result and fetch is never called.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { TOOL_REGISTRY, ToolArgError, guardTool } from "../../../mcp/tools.mjs";
import { TOOLS } from "@/lib/assistant/tools";

const UUID = "00000000-0000-4000-a000-000000000001";
const NIL = "00000000-0000-0000-0000-000000000000";

/** tool name -> the argument names that become path segments. */
const ID_ARGS: Record<string, string[]> = {
  get_project: ["project_id"],
  update_project: ["project_id"],
  request_project_deletion: ["project_id"],
  list_milestones: ["project_id"],
  create_milestone: ["project_id"],
  update_milestone: ["milestone_id"],
  list_tasks: ["project_id"],
  get_task: ["task_id"],
  create_task: ["project_id"],
  update_task: ["task_id"],
  request_task_deletion: ["task_id"],
  withdraw_deletion_request: ["request_id"],
  list_risks: ["project_id"],
  create_risk: ["project_id"],
  update_risk: ["risk_id"],
  list_issues: ["project_id"],
  create_issue: ["project_id"],
  update_issue: ["issue_id"],
  get_budget: ["project_id"],
  get_evm: ["project_id"],
  get_change_request: ["change_request_id"],
  get_document: ["document_id"],
};

const HOSTILE_IDS = [
  "../unlock",
  `${UUID}/../unlock`,
  `${UUID}/../../projects`,
  `${UUID}/unlock`,
  `${UUID}?x=1`,
  `${UUID}#frag`,
  `${UUID}\\..\\unlock`,
  "%2e%2e%2funlock",
  `${UUID}%2F..%2Funlock`,
  "..",
  ".",
  "",
  " ",
  "not-a-uuid",
  `${UUID} `,
  `${UUID}\n`,
  "http://evil.example/x",
  "//evil.example/x",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("every id argument is validated before a request is built", () => {
  const cases = Object.entries(ID_ARGS).flatMap(([tool, args]) =>
    args.flatMap((arg) => HOSTILE_IDS.map((bad) => [tool, arg, bad] as const)),
  );

  it.each(cases)("%s rejects %s = %j", (toolName, arg, bad) => {
    const tool = TOOL_REGISTRY.find((t) => t.name === toolName)!;
    // Required companions so a failure can only come from the id itself.
    const args: Record<string, unknown> = { name: "n", title: "t", code: "C", severity: "low", likelihood: "low", priority: "low", reason: "r", [arg]: bad };
    expect(() => tool.toRequest(args)).toThrow(ToolArgError);
  });

  it.each([42, true, {}, ["a"], { toString: () => UUID }] as unknown[])("rejects a non-string id: %j", (bad) => {
    const tool = TOOL_REGISTRY.find((t) => t.name === "create_milestone")!;
    expect(() => tool.toRequest({ project_id: bad, name: "M" })).toThrow(ToolArgError);
  });

  it("names the offending argument in the error", () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === "update_task")!;
    expect(() => tool.toRequest({ task_id: "../unlock" })).toThrow("task_id must be a UUID");
  });

  it("covers every tool that interpolates an id (a new id tool must be added to ID_ARGS)", () => {
    const idTools = TOOL_REGISTRY.filter((t) => /\/:id|[0-9a-f]{8}-/.test(t.toRequest({}).path)).map((t) => t.name);
    expect(idTools.sort()).toEqual(Object.keys(ID_ARGS).sort());
  });
});

describe("valid ids produce exactly the tool's own route", () => {
  it.each([
    ["get_project", { project_id: UUID }, `/api/projects/${UUID}`, "GET"],
    ["create_milestone", { project_id: UUID, name: "M" }, `/api/projects/${UUID}/milestones`, "POST"],
    ["update_milestone", { milestone_id: UUID, status: "on_track" }, `/api/milestones/${UUID}`, "PATCH"],
    ["update_task", { task_id: UUID, status_type: "started" }, `/api/tasks/${UUID}`, "PATCH"],
    ["get_budget", { project_id: UUID }, `/api/projects/${UUID}/budget`, "GET"],
  ])("%s", (name, args, path, method) => {
    const req = TOOL_REGISTRY.find((t) => t.name === name)!.toRequest(args);
    expect(req.path).toBe(path);
    expect(req.method).toBe(method);
  });

  it("accepts an upper-case UUID", () => {
    const req = TOOL_REGISTRY.find((t) => t.name === "get_task")!.toRequest({ task_id: UUID.toUpperCase() });
    expect(req.path).toBe(`/api/tasks/${UUID.toUpperCase()}`);
  });

  it("keeps the id out of the request body", () => {
    const req = TOOL_REGISTRY.find((t) => t.name === "update_task")!.toRequest({ task_id: UUID, name: "x" });
    expect(req.body).toEqual({ name: "x" });
  });
});

describe("toRequest({}) never throws (fallback.ts probes it for the method)", () => {
  it.each(TOOL_REGISTRY.map((t) => [t.name]))("%s", (name) => {
    const tool = TOOL_REGISTRY.find((t) => t.name === name)!;
    expect(() => tool.toRequest({})).not.toThrow();
  });

  it("a missing id becomes the nil UUID, never 'undefined' or a made-up segment", () => {
    const req = TOOL_REGISTRY.find((t) => t.name === "get_project")!.toRequest({});
    expect(req.path).toBe(`/api/projects/${NIL}`);
  });

  it("the assistant's TOOLS view carries the same guarded toRequest", () => {
    const view = TOOLS.find((t) => t.definition.name === "create_milestone")!;
    expect(() => view.toRequest({ project_id: `${UUID}/../unlock`, name: "M" })).toThrow(ToolArgError);
  });
});

describe("page and limit can only be query values", () => {
  it("encodes a hostile page/limit instead of splicing it into the URL", () => {
    const tool = TOOL_REGISTRY.find((t) => t.name === "list_milestones")!;
    const req = tool.toRequest({ project_id: UUID, page: "1&x=../unlock#", limit: "20/../../unlock" });
    const url = new URL(req.path, "http://nopm.invalid");
    expect(url.pathname).toBe(`/api/projects/${UUID}/milestones`);
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "page"]);
    expect(url.searchParams.get("page")).toBe("1&x=../unlock#");
    expect(url.hash).toBe("");
  });

  it("still defaults to page 1 / limit 20", () => {
    expect(TOOL_REGISTRY.find((t) => t.name === "list_clashes")!.toRequest({}).path).toBe("/api/clashes?page=1&limit=20");
  });
});

describe("second layer: a request is pinned to its own tool's route shape", () => {
  // A tool that forgot idSeg() — exactly the future mistake this layer exists for.
  const careless = guardTool({
    name: "careless",
    toRequest: (a: Record<string, unknown>) => ({
      path: `/api/projects/${a.id ?? NIL}/milestones`,
      method: "POST",
    }),
  });

  it("lets the tool's own route through", () => {
    expect(careless.toRequest({ id: UUID }).path).toBe(`/api/projects/${UUID}/milestones`);
    expect(careless.toRequest({}).path).toBe(`/api/projects/${NIL}/milestones`);
  });

  it.each([
    `${UUID}/../unlock`,
    `${UUID}/unlock`,
    `${UUID}/../../tokens`,
    `${UUID}%2F..%2Funlock`,
    "..",
    `${UUID}#`,
    `${UUID} x`,
  ])("refuses a spliced id %j", (id) => {
    expect(() => careless.toRequest({ id })).toThrow(ToolArgError);
  });

  it("refuses a change of method", () => {
    const flipping = guardTool({
      name: "flip",
      toRequest: (a: Record<string, unknown>) => ({ path: "/api/clashes", method: a.m === 1 ? "DELETE" : "GET" }),
    });
    expect(() => flipping.toRequest({ m: 1 })).toThrow(ToolArgError);
  });
});

describe("end to end through /api/mcp: a hostile id never reaches fetch", () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer npm_test",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    return res.json();
  }

  it("returns a 'Bad arguments' tool result and makes no request", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);

    const out = await callTool("create_milestone", { project_id: `${UUID}/../unlock?x=`, name: "M" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/Bad arguments: project_id must be a UUID/);
  });

  it("a valid id does reach the API, at the tool's own path, with the caller's token", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { id: UUID } })));
    vi.stubGlobal("fetch", fetchSpy);

    const out = await callTool("get_project", { project_id: UUID });

    expect(out.result.isError).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(`http://localhost/api/projects/${UUID}`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer npm_test");
  });
});
