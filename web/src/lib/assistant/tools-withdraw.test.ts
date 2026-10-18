/** Q-GOV-27: the assistant/agent can withdraw ITS OWN deletion request, and still has no approve tool. */
import { describe, it, expect } from "vitest";
import { TOOLS, TOOL_SCOPES } from "./tools";
import { MCP_TOOLS, ToolArgError } from "../../../mcp/tools.mjs";

const ID = "00000000-0000-4000-a000-000000000001";
const tool = TOOLS.find((t) => t.definition.name === "withdraw_deletion_request")!;

describe("withdraw_deletion_request", () => {
  it("is in the assistant registry and the MCP list", () => {
    expect(tool).toBeDefined();
    expect((MCP_TOOLS as Array<{ name: string }>).some((t) => t.name === "withdraw_deletion_request")).toBe(true);
  });
  it("POSTs the withdraw route for the given request, with no body", () => {
    expect(tool.toRequest({ request_id: ID })).toEqual({ path: `/api/deletion-requests/${ID}/withdraw`, method: "POST" });
  });
  it("rejects a path-splicing id", () => {
    expect(() => tool.toRequest({ request_id: `${ID}/../approve` })).toThrow(ToolArgError);
  });
  it("its description says it cannot approve or reject", () => {
    expect(tool.definition.description).toMatch(/cannot approve or reject/);
  });
  it("NO assistant or MCP registry tool can approve or reject a deletion, and the scope ceiling holds no approve scope", () => {
    for (const t of MCP_TOOLS as Array<{ name: string; toRequest: (a: Record<string, unknown>) => { path: string } }>) {
      if (t.name === "sign_off_rebaseline" || t.name === "apply_rebaseline") continue; // MCP-only, human-token governance tools (locked out of the assistant elsewhere)
      let path = "";
      try {
        path = t.toRequest({ request_id: ID, task_id: ID, project_id: ID }).path;
      } catch {
        /* an arg-validation throw means no path */
      }
      expect(path, `${t.name} must not hit an approve/reject route`).not.toMatch(/\/(approve|reject)\b/);
    }
    for (const s of TOOL_SCOPES) expect(s).not.toMatch(/approve|decide/);
  });
});
