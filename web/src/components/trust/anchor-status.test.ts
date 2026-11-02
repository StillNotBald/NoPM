import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnchorStatus } from "./anchor-status";
import type { AnchorView } from "@/lib/audit/anchor/view";

const base: AnchorView = { state: "not_anchored", chain_seq: null, anchored_at: null, row_count: null, rows_behind: null, since: null, reset_at: null };
const html = (a: AnchorView | null) => renderToStaticMarkup(createElement(AnchorStatus, { anchor: a }));
const text = (a: AnchorView | null) => html(a).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("AnchorStatus (R-170a)", () => {
  it("never hides: a missing view and an unset variable both read 'Not anchored' with one line on how to turn it on", () => {
    for (const a of [null, base]) {
      const t = text(a);
      expect(t).toContain("Not anchored");
      expect(t).toContain("NOPM_ANCHOR_DB_URL");
      expect(html(a)).toContain('data-state="not_anchored"');
    }
  });

  it("never green when not anchored", () => {
    expect(html(base)).not.toContain("bg-success");
  });

  it("anchored: the time and the row count, green", () => {
    const a: AnchorView = { ...base, state: "anchored", chain_seq: 1234, row_count: 1234, anchored_at: "2026-10-18T20:09:00.000Z" };
    expect(text(a)).toContain("Anchored 2026-10-18 20:09 UTC (1,234 rows)");
    expect(html(a)).toContain("bg-success/15");
  });

  it("behind: says how many rows, not green", () => {
    const a: AnchorView = { ...base, state: "behind", row_count: 10, anchored_at: "2026-10-18T20:09:00.000Z", rows_behind: 3 };
    expect(text(a)).toContain("3 rows behind");
    expect(html(a)).not.toContain("bg-success");
  });

  it("unreachable: amber, since when, and that work is not affected", () => {
    const a: AnchorView = { ...base, state: "unreachable", since: "2026-10-19T01:07:00.000Z" };
    const t = text(a);
    expect(t).toContain("Anchor unreachable");
    expect(t).toContain("since 2026-10-19 01:07 UTC");
    expect(t).toContain("Work is not affected");
    expect(html(a)).toContain("bg-warning/15");
    expect(html(a)).toContain('role="status"');
  });

  it("mismatch: red, an alert, and plain words about what it means", () => {
    const a: AnchorView = { ...base, state: "mismatch", since: "2026-10-19T01:07:00.000Z" };
    const t = text(a);
    expect(t).toContain("Anchor mismatch");
    expect(t).toContain("Treat the log as altered");
    expect(html(a)).toContain("bg-danger/15");
    expect(html(a)).toContain('role="alert"');
  });

  it("fits a 390 px screen: wrapping flex rows, breakable text, no fixed widths", () => {
    const out = html({ ...base, state: "anchored", row_count: 5, anchored_at: "2026-10-18T20:09:00.000Z" });
    expect(out).toContain("flex-wrap");
    expect(out).toContain("min-w-0");
    expect(out).toContain("break-words");
    expect(out).not.toMatch(/\bw-\[|\bmin-w-\[/);
  });
});

describe("AnchorStatus: as-of line and re-baseline (W2-18, W2-08)", () => {
  const html2 = (a: AnchorView | null, asOf: string | null) => renderToStaticMarkup(createElement(AnchorStatus, { anchor: a, asOf }));
  const txt = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const anchored: AnchorView = { ...base, state: "anchored", row_count: 3, anchored_at: "2026-10-18T20:09:00.000Z" };

  it("says when the shown state was last checked", () => {
    expect(txt(html2(anchored, "2026-10-19T08:15:00.000Z"))).toContain("State as of the last check, 2026-10-19 08:15 UTC.");
  });
  it("says so when no check is recorded, and shows nothing extra for 'not anchored'", () => {
    expect(txt(html2(anchored, null))).toContain("No check yet");
    expect(html2(base, null)).not.toContain("anchor-as-of");
  });
  it("shows when the owner re-baselined after a restore", () => {
    expect(txt(html2({ ...anchored, reset_at: "2026-10-20T03:00:00.000Z" }, null))).toContain("Re-baselined on 2026-10-20 03:00 UTC after a restore.");
  });
});
