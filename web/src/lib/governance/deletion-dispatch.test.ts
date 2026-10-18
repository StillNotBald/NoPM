import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveDeletionApproveScope,
  resolveDeletionCommitRpc,
  resolveDeletionRequestScope,
} from "./deletion-dispatch";
import { RuleError } from "@/lib/api/errors";

// R-84: the actual db.rpc(...) call this dispatch map feeds lives in the
// governed decision path (deletion-dispatch.ts only resolves names/scopes — it
// never calls .rpc()). Since the 2026-10-16 principal-four-eyes change the
// approve route is a thin wrapper and the call lives in
// src/lib/governance/decide.ts (approveDeletion) so the console, CLI, MCP and
// chat connectors share it. Same source-text-drift pattern as
// lock-db-backstop.test.ts: read that file and assert the provenance fields
// are actually threaded onto the RPC call args, not just present somewhere in
// the file.
const approveRoute = readFileSync(join(__dirname, "decide.ts"), "utf8");

describe("resolveDeletionCommitRpc — approve-route dispatch (devops-wave1b, U2)", () => {
  it("resolves 'task' to the task commit RPC", () => {
    expect(resolveDeletionCommitRpc("task")).toBe("nopm_commit_task_deletion");
  });

  it("resolves 'project' to the project commit RPC (Decision 3 sibling)", () => {
    expect(resolveDeletionCommitRpc("project")).toBe("nopm_commit_project_deletion");
  });

  // G8 (migration 0102): every governed record is deleted by request, one sibling RPC each.
  it.each([
    ["risk", "nopm_commit_risk_deletion"],
    ["issue", "nopm_commit_issue_deletion"],
    ["expense", "nopm_commit_expense_deletion"],
    ["document", "nopm_commit_document_deletion"],
    ["milestone", "nopm_commit_milestone_deletion"],
  ])("resolves %j to its own commit RPC %j", (targetType, rpc) => {
    expect(resolveDeletionCommitRpc(targetType)).toBe(rpc);
  });

  it.each(["clash", "program", "bogus", ""])(
    "throws RuleError (422) for an unsupported target_type %j (clashes and programs are not governed records)",
    (targetType) => {
      expect(() => resolveDeletionCommitRpc(targetType)).toThrowError(RuleError);
      try {
        resolveDeletionCommitRpc(targetType);
      } catch (e) {
        expect((e as RuleError).status).toBe(422);
        expect((e as RuleError).message).toContain(targetType);
      }
    },
  );
});

describe("per-type decision-verb scope gates (adversarial-verify fix: task:delete:approve must not gate project approvals)", () => {
  it("approve/reject scope follows the request's target type", () => {
    expect(resolveDeletionApproveScope("task")).toBe("task:delete:approve");
    expect(resolveDeletionApproveScope("project")).toBe("project:delete:approve");
  });

  it("withdraw (maker verb) scope follows the request's target type", () => {
    expect(resolveDeletionRequestScope("task")).toBe("task:delete:request");
    expect(resolveDeletionRequestScope("project")).toBe("project:delete:request");
  });

  it.each(["clash", "program", "bogus", ""])(
    "both resolvers throw RuleError (422) for unsupported target_type %j",
    (targetType) => {
      expect(() => resolveDeletionApproveScope(targetType)).toThrowError(RuleError);
      expect(() => resolveDeletionRequestScope(targetType)).toThrowError(RuleError);
    },
  );

  it.each(["risk", "issue", "expense", "document", "milestone"])("%s: approve and request scopes are its own", (t) => {
    expect(resolveDeletionApproveScope(t)).toBe(`${t}:delete:approve`);
    expect(resolveDeletionRequestScope(t)).toBe(`${t}:delete:request`);
  });

  it("cross-type is never a subset: neither task scope grants the project verb, in either direction", () => {
    expect(resolveDeletionApproveScope("project")).not.toBe(resolveDeletionApproveScope("task"));
    expect(resolveDeletionRequestScope("project")).not.toBe(resolveDeletionRequestScope("task"));
  });
});

describe("R-84: the approve path threads provenance onto the commit RPC call", () => {
  const rpcStart = approveRoute.indexOf("db.rpc(resolveDeletionCommitRpc(");
  const rpcCall = approveRoute.slice(rpcStart, approveRoute.indexOf("});", rpcStart));

  it("finds the dispatching RPC call in decide.ts", () => {
    expect(rpcStart).toBeGreaterThan(-1);
  });

  it("passes p_channel and p_correlation_id from the actor alongside the existing args", () => {
    expect(rpcCall).toMatch(/p_channel:\s*actor\.channel\s*\?\?\s*null/);
    expect(rpcCall).toMatch(/p_correlation_id:\s*actor\.requestId\s*\?\?\s*null/);
    // Not p_request_id — that key is already the deletion_requests row id
    // on this same call; a second p_request_id would silently overwrite it in
    // the object literal instead of adding a new arg.
    expect(rpcCall).toMatch(/p_request_id:\s*id\b/);
  });

  it("passes the approver's PRINCIPAL (the human) and the optional note (principal four-eyes, 0045)", () => {
    expect(rpcCall).toMatch(/p_approver_principal_id:\s*principal\b/);
    expect(rpcCall).toMatch(/p_note:\s*note\b/);
  });
});
