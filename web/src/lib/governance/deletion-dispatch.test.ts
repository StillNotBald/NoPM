import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REGISTER_DELETION_ENTITIES,
  isRegisterDeletionKind,
  isRegisterDeletionTarget,
  registerDeletionKindFor,
  registerEntityOfKind,
  requireDeletionRequestScope,
  resolveDeletionApproveScope,
  resolveDeletionCommitRpc,
  resolveDeletionRequestScope,
} from "./deletion-dispatch";
import { RuleError, ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

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
    // Wave 5 (R-176, migration 0113): programs, sprints, resources, allocations and clashes.
    ["program", "nopm_commit_program_deletion"],
    ["sprint", "nopm_commit_sprint_deletion"],
    ["resource", "nopm_commit_resource_deletion"],
    ["allocation", "nopm_commit_allocation_deletion"],
    ["clash", "nopm_commit_clash_deletion"],
  ])("resolves %j to its own commit RPC %j", (targetType, rpc) => {
    expect(resolveDeletionCommitRpc(targetType)).toBe(rpc);
  });

  it.each(["widget", "bogus", ""])(
    "throws RuleError (422) for an unsupported target_type %j",
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

  it.each(["widget", "bogus", ""])(
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

// ── wave 5: the five registers (R-176) ──────────────────────────────────────────────────────────────

const tokenActor = (scopes: string[]): Actor =>
  ({ type: "token", id: "tok", label: "t", workspaceId: "ws", scopes, principalRole: "manager" }) as unknown as Actor;

describe("the five wave-5 registers", () => {
  it("are program, sprint, resource, allocation and clash, each with its own kind string", () => {
    expect([...REGISTER_DELETION_ENTITIES]).toEqual(["program", "sprint", "resource", "allocation", "clash"]);
    for (const e of REGISTER_DELETION_ENTITIES) {
      expect(isRegisterDeletionTarget(e)).toBe(true);
      expect(registerDeletionKindFor(e)).toBe(`${e}_deletion`);
      expect(isRegisterDeletionKind(`${e}_deletion`)).toBe(true);
      expect(registerEntityOfKind(registerDeletionKindFor(e))).toBe(e);
    }
    for (const t of ["task", "project", "risk", "milestone", "widget"]) expect(isRegisterDeletionTarget(t)).toBe(false);
  });

  it("are approved with an existing privileged verb, never a wildcard-grantable name", () => {
    expect(resolveDeletionApproveScope("program")).toBe("project:delete:approve");
    for (const t of ["sprint", "resource", "allocation", "clash"]) expect(resolveDeletionApproveScope(t)).toBe("task:delete:approve");
  });

  it("are requested (and withdrawn) with their own <entity>:delete:request scope", () => {
    for (const t of ["program", "sprint", "resource", "allocation", "clash"]) {
      expect(resolveDeletionRequestScope(t)).toBe(`${t}:delete:request`);
    }
  });

  it("a token with the request scope may ask; so may one minted with the old write scope (backward compatible)", () => {
    expect(() => requireDeletionRequestScope(tokenActor(["program:delete:request"]), "program")).not.toThrow();
    expect(() => requireDeletionRequestScope(tokenActor(["program:write"]), "program")).not.toThrow();
    expect(() => requireDeletionRequestScope(tokenActor(["resource:write"]), "allocation")).not.toThrow();
    expect(() => requireDeletionRequestScope(tokenActor(["program:*"]), "program")).not.toThrow();
  });

  it("a token with neither is refused (403), and a write scope of another register does not help", () => {
    expect(() => requireDeletionRequestScope(tokenActor(["program:read"]), "program")).toThrowError(ScopeError);
    expect(() => requireDeletionRequestScope(tokenActor(["sprint:write"]), "clash")).toThrowError(ScopeError);
    expect(() => requireDeletionRequestScope(tokenActor(["sprint:delete:request"]), "program")).toThrowError(ScopeError);
  });

  it("a viewer session is read-only", () => {
    const viewer = { type: "user", id: "u", label: "v", workspaceId: "ws", role: "viewer" } as unknown as Actor;
    expect(() => requireDeletionRequestScope(viewer, "sprint")).toThrowError(ScopeError);
  });
});
