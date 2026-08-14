import { describe, it, expect } from "vitest";
import {
  resolveDeletionApproveScope,
  resolveDeletionCommitRpc,
  resolveDeletionRequestScope,
} from "./deletion-dispatch";
import { RuleError } from "@/lib/api/errors";

describe("resolveDeletionCommitRpc — approve-route dispatch (devops-wave1b, U2)", () => {
  it("resolves 'task' to the task commit RPC", () => {
    expect(resolveDeletionCommitRpc("task")).toBe("nopm_commit_task_deletion");
  });

  it("resolves 'project' to the project commit RPC (Decision 3 sibling)", () => {
    expect(resolveDeletionCommitRpc("project")).toBe("nopm_commit_project_deletion");
  });

  it.each(["milestone", "risk", "issue", "clash", "bogus", ""])(
    "throws RuleError (422) for an unsupported target_type %j — milestones/risks/issues stay audit-only hard-delete (Decision 3), never a deletion_requests row",
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

  it.each(["milestone", "risk", "issue", "bogus", ""])(
    "both resolvers throw RuleError (422) for unsupported target_type %j",
    (targetType) => {
      expect(() => resolveDeletionApproveScope(targetType)).toThrowError(RuleError);
      expect(() => resolveDeletionRequestScope(targetType)).toThrowError(RuleError);
    },
  );

  it("cross-type is never a subset: neither task scope grants the project verb, in either direction", () => {
    expect(resolveDeletionApproveScope("project")).not.toBe(resolveDeletionApproveScope("task"));
    expect(resolveDeletionRequestScope("project")).not.toBe(resolveDeletionRequestScope("task"));
  });
});
