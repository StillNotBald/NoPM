import { describe, it, expect } from "vitest";
import { RuleError } from "@/lib/api/errors";
import {
  REBASELINE_TRANSITIONS,
  assertApplicable,
  assertSignoffOpen,
  isLegalRebaselineTransition,
  statusFromVotes,
  type RebaselineStatus,
} from "./rebaseline-lifecycle";

const ALL: RebaselineStatus[] = ["draft", "pending_approval", "approved", "applied", "rejected"];

function thrown(fn: () => void): RuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RuleError);
    return e as RuleError;
  }
  throw new Error("expected the call to throw a RuleError");
}

describe("rebaseline state machine (R1/M2)", () => {
  it("allows exactly the forward moves and nothing else", () => {
    const legal = ALL.flatMap((from) => ALL.filter((to) => from !== to && isLegalRebaselineTransition(from, to)).map((to) => `${from}>${to}`));
    expect(legal.sort()).toEqual(
      ["approved>applied", "draft>pending_approval", "pending_approval>approved", "pending_approval>rejected"].sort(),
    );
  });

  it("rejected and applied are terminal", () => {
    expect(REBASELINE_TRANSITIONS.rejected).toEqual([]);
    expect(REBASELINE_TRANSITIONS.applied).toEqual([]);
  });

  it("the revive / regress moves the red-team used are all illegal", () => {
    expect(isLegalRebaselineTransition("rejected", "approved")).toBe(false); // flip no_go -> go
    expect(isLegalRebaselineTransition("rejected", "pending_approval")).toBe(false);
    expect(isLegalRebaselineTransition("applied", "approved")).toBe(false); // regress after a later vote
    expect(isLegalRebaselineTransition("applied", "applied")).toBe(true); // not a transition
    expect(isLegalRebaselineTransition("approved", "rejected")).toBe(false);
    expect(isLegalRebaselineTransition("draft", "approved")).toBe(false);
  });

  it("an unknown status is never legal", () => {
    expect(isLegalRebaselineTransition("bogus", "approved")).toBe(false);
  });
});

describe("assertSignoffOpen", () => {
  it("passes only while the rebaseline awaits its decision", () => {
    expect(() => assertSignoffOpen("pending_approval")).not.toThrow();
  });

  it("refuses every other state with 422 rebaseline_not_pending", () => {
    for (const status of ["draft", "approved", "applied", "rejected"]) {
      const err = thrown(() => assertSignoffOpen(status));
      expect([err.status, err.code], status).toEqual([422, "rebaseline_not_pending"]);
    }
  });

  it("explains a draft differently from a decided rebaseline", () => {
    expect(thrown(() => assertSignoffOpen("draft")).message).toMatch(/draft/);
    expect(thrown(() => assertSignoffOpen("rejected")).message).toMatch(/already rejected/);
  });
});

describe("assertApplicable", () => {
  it("passes for approved only", () => {
    expect(() => assertApplicable("approved")).not.toThrow();
    for (const status of ["draft", "pending_approval", "rejected"]) {
      expect(thrown(() => assertApplicable(status)).message).toContain(`status is '${status}', must be 'approved'`);
    }
  });

  it("a second apply is 422 already_applied", () => {
    const err = thrown(() => assertApplicable("applied"));
    expect([err.status, err.code]).toEqual([422, "already_applied"]);
  });
});

describe("statusFromVotes", () => {
  it("any no_go rejects", () => {
    expect(statusFromVotes([{ vote: "go" }, { vote: "no_go" }], "pending_approval")).toBe("rejected");
  });

  it("all go (and none pending) approves", () => {
    expect(statusFromVotes([{ vote: "go" }, { vote: "go" }], "pending_approval")).toBe("approved");
  });

  it("an outstanding pending vote keeps it pending", () => {
    expect(statusFromVotes([{ vote: "go" }, { vote: "pending" }], "pending_approval")).toBe("pending_approval");
    expect(statusFromVotes([], "pending_approval")).toBe("pending_approval");
  });
});
