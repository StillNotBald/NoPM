import { describe, it, expect } from "vitest";
import { compareAnchor, unreachableStatus } from "./compare";
import { anchorLine } from "@/lib/audit/chain-head";
import { receiptToView, toAnchorView } from "./view";

const anchor = { workspace_id: "w", chain_seq: 10, head_hash: "h10", row_count: 10, anchored_at: "2026-10-18T20:09:00.000Z" };

describe("compareAnchor (R-169)", () => {
  it("no anchor is not_anchored", () => {
    expect(compareAnchor(null, { headSeq: 10, hashAtAnchorSeq: "h10" }).state).toBe("not_anchored");
  });
  it("same row at the head is anchored", () => {
    expect(compareAnchor(anchor, { headSeq: 10, hashAtAnchorSeq: "h10" })).toMatchObject({ state: "anchored", rows_behind: null, chain_seq: 10 });
  });
  it("same row below a longer chain is behind by the difference", () => {
    expect(compareAnchor(anchor, { headSeq: 14, hashAtAnchorSeq: "h10" })).toMatchObject({ state: "behind", rows_behind: 4 });
  });
  it.each([
    ["head below the anchor (newest rows deleted)", { headSeq: 8, hashAtAnchorSeq: null }],
    ["empty live chain", { headSeq: null, hashAtAnchorSeq: null }],
    ["row missing at the anchored seq", { headSeq: 12, hashAtAnchorSeq: null }],
    ["different hash at the anchored seq", { headSeq: 10, hashAtAnchorSeq: "other" }],
    ["different hash below a longer chain", { headSeq: 20, hashAtAnchorSeq: "other" }],
  ])("%s is mismatch", (_n, live) => {
    const s = compareAnchor(anchor, live);
    expect(s.state).toBe("mismatch");
    expect(s.reason).toBeTruthy();
  });
  it("unreachable carries the last known anchor and the reason, and never claims anchored", () => {
    expect(unreachableStatus("down", "2026-10-19T00:00:00Z", { ...compareAnchor(anchor, { headSeq: 10, hashAtAnchorSeq: "h10" }) })).toMatchObject({
      state: "unreachable", reason: "down", since: "2026-10-19T00:00:00Z", chain_seq: 10,
    });
  });
});

describe("anchorLine (audit pack cover, R-169f)", () => {
  it("reads not anchored for a missing status and for an unset variable", () => {
    expect(anchorLine(null)).toBe("Anchor: not anchored");
    expect(anchorLine(undefined)).toBe("Anchor: not anchored");
    expect(anchorLine({ ...compareAnchor(null, { headSeq: 1, hashAtAnchorSeq: null }) })).toBe("Anchor: not anchored");
  });
  it("names the time and the row count when anchored", () => {
    expect(anchorLine(compareAnchor(anchor, { headSeq: 10, hashAtAnchorSeq: "h10" }))).toBe("Anchor: anchored 2026-10-18 20:09 UTC (10 rows)");
  });
  it("says how far behind, and never hides a mismatch or an unreachable sink", () => {
    expect(anchorLine(compareAnchor(anchor, { headSeq: 13, hashAtAnchorSeq: "h10" }))).toContain("3 rows behind");
    expect(anchorLine(compareAnchor(anchor, { headSeq: 9, hashAtAnchorSeq: null }))).toContain("MISMATCH");
    expect(anchorLine(unreachableStatus("down"))).toContain("unreachable");
  });
});

describe("receiptToView and toAnchorView (Trust Center)", () => {
  const receipt = { status: "anchored" as const, chain_seq: 10, anchored_at: "2026-10-18T20:09:00Z", row_count: 10, streak_started_at: null };
  it("is not anchored whenever the variable is unset, whatever an old receipt says", () => {
    expect(receiptToView(receipt, false).state).toBe("not_anchored");
    expect(receiptToView(null, true).state).toBe("not_anchored");
  });
  it("maps the receipt statuses", () => {
    expect(receiptToView(receipt, true)).toMatchObject({ state: "anchored", chain_seq: 10 });
    expect(receiptToView({ ...receipt, status: "failed", streak_started_at: "2026-10-19T00:00:00Z" }, true)).toMatchObject({ state: "unreachable", since: "2026-10-19T00:00:00Z" });
    expect(receiptToView({ ...receipt, status: "mismatch", streak_started_at: "2026-10-19T00:00:00Z" }, true).state).toBe("mismatch");
  });
  it("coerces a verify response and rejects junk", () => {
    expect(toAnchorView({ state: "behind", chain_seq: "4", anchored_at: "x", row_count: 4, rows_behind: 2, since: null })).toMatchObject({ state: "behind", chain_seq: 4, rows_behind: 2 });
    expect(toAnchorView({ state: "green" })).toBeNull();
    expect(toAnchorView(null)).toBeNull();
  });
});
