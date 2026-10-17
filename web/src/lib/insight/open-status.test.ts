import { describe, expect, it } from "vitest";
import {
  countOpenIssues,
  countOpenRisks,
  isOpenIssue,
  isOpenRisk,
} from "./open-status";

describe("open register statuses", () => {
  it("treats open and mitigating risks as open, everything else as not", () => {
    expect(isOpenRisk("open")).toBe(true);
    expect(isOpenRisk("mitigating")).toBe(true);
    expect(isOpenRisk("accepted")).toBe(false);
    expect(isOpenRisk("closed")).toBe(false);
    expect(isOpenRisk(null)).toBe(false);
    expect(isOpenRisk(undefined)).toBe(false);
  });

  it("treats open and in_progress issues as open, everything else as not", () => {
    expect(isOpenIssue("open")).toBe(true);
    expect(isOpenIssue("in_progress")).toBe(true);
    expect(isOpenIssue("resolved")).toBe(false);
    expect(isOpenIssue("closed")).toBe(false);
    expect(isOpenIssue(null)).toBe(false);
  });

  it("counts the seed mix the audit measured: 6 risks, 4 open; 6 issues, 4 open", () => {
    const risks = ["mitigating", "open", "accepted", "open", "mitigating", "closed"].map((status) => ({ status }));
    const issues = ["open", "resolved", "in_progress", "open", "resolved", "in_progress"].map((status) => ({ status }));
    expect(risks).toHaveLength(6);
    expect(countOpenRisks(risks)).toBe(4);
    expect(issues).toHaveLength(6);
    expect(countOpenIssues(issues)).toBe(4);
  });
});
