/**
 * R-159 (owner decision Q1): an emergency change commits on raise, needs no approver and is only FLAGGED.
 * The flag shows wherever a change request is listed or summarised, and nothing says "overdue" any more.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emergencyNoteText } from "./change-detail";
import { isEmergencyChange } from "./change-form";
import { renderWeeklyReportHtml, type WeeklySnapshot } from "@/lib/reports/weekly-html";
import { buildDigestCard } from "@/lib/integrations/lark/cards";
import { Badge } from "@/components/ui/badge";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("isEmergencyChange", () => {
  it("reads either the flag or the tier", () => {
    expect(isEmergencyChange({ is_emergency: true })).toBe(true);
    expect(isEmergencyChange({ tier: "emergency" })).toBe(true);
    expect(isEmergencyChange({ is_emergency: false, tier: "normal" })).toBe(false);
    expect(isEmergencyChange({})).toBe(false);
  });
});

describe("change detail wording", () => {
  it("says committed without approval, with the date and the raiser", () => {
    const text = emergencyNoteText({ raised_at: "2026-10-18T03:00:00.000Z", requested_by_label: "Priya Nair" });
    expect(text).toMatch(/^Emergency change: committed without approval on .+ by Priya Nair$/);
    expect(text).not.toMatch(/overdue/i);
  });
});

describe("where the flag shows", () => {
  it("the Change Control list row carries a danger Emergency badge beside the status", () => {
    const s = src("components/change-control/change-table.tsx");
    expect(s).toMatch(/isEmergencyChange\(cr\)/);
    expect(s).toMatch(/tone="danger"[\s\S]{0,80}Emergency/);
    expect(renderToStaticMarkup(createElement(Badge, { tone: "danger", size: "sm" }, "Emergency"))).toContain("Emergency");
  });

  it("the raise form says it commits immediately with no approver and is flagged in every report", () => {
    const s = src("components/change-control/change-form.tsx");
    expect(s).toContain("commits immediately with no approver and is flagged as an emergency in every report");
    expect(s).not.toMatch(/48 hours|approve afterwards/);
  });

  it("no page or component keeps a retro-overdue marker", () => {
    for (const f of [
      "components/change-control/change-detail.tsx",
      "components/change-control/change-table.tsx",
      "app/(console)/change-control/page.tsx",
      "app/(console)/approvals/page.tsx",
      "components/review/queue-list.tsx",
    ]) {
      const s = src(f);
      expect(s, f).not.toMatch(/isRetroOverdue|retro approval overdue|Emergency change, overdue/);
    }
  });

  it("the review queue flags an emergency item and gives it no decide-by date", () => {
    const s = src("components/review/queue-list.tsx");
    expect(s).toMatch(/item\.tier === "emergency"/);
    expect(s).toMatch(/item\.deadline && item\.tier !== "emergency"/);
  });
});

describe("weekly report and digest", () => {
  const snap = (emergencyChanges?: { count: number; items: { reference: string | null; title: string }[] }): WeeklySnapshot => ({
    weekStart: "2026-10-12",
    staleDays: 14,
    stale: [],
    digest: {
      workspaceName: "Acme", generatedAt: "2026-10-18T00:00:00.000Z", appUrl: "https://example.test", projects: [], milestonesDueSoon: [],
      openHighRisks: 0, pendingApprovals: 0, emergencyChanges,
    } as unknown as WeeklySnapshot["digest"],
  });

  it("the HTML report lists this week's emergency changes and never says overdue for approval", () => {
    const html = renderWeeklyReportHtml(snap({ count: 2, items: [{ reference: "CR-7", title: "Hotfix <b>db</b>" }, { reference: null, title: "Cut over" }] }));
    expect(html).toContain("Emergency changes this week: 2");
    expect(html).toContain("CR-7");
    expect(html).toContain("Hotfix &lt;b&gt;db&lt;/b&gt;");
    expect(html).not.toMatch(/overdue for approval/);
  });

  it("states zero for a quiet week, and for a report stored before the field existed", () => {
    expect(renderWeeklyReportHtml(snap({ count: 0, items: [] }))).toContain("Emergency changes this week: 0");
    expect(renderWeeklyReportHtml(snap())).toContain("Emergency changes this week: 0");
  });

  it("the Lark digest card names the emergency changes only when there are some", () => {
    const base = { workspaceName: "Acme", generatedAt: "2026-10-18T00:00:00.000Z", appUrl: "https://example.test", projects: [], milestonesDueSoon: [], openHighRisks: 0, pendingApprovals: 0 };
    const withOne = JSON.stringify(buildDigestCard({ ...base, emergencyChanges: { count: 1, items: [{ reference: "CR-7", title: "Hotfix" }] } }));
    expect(withOne).toContain("Emergency changes this week: 1");
    expect(withOne).not.toMatch(/overdue/i);
    expect(JSON.stringify(buildDigestCard(base))).not.toContain("Emergency changes");
  });
});

describe("audit pack", () => {
  it("keeps the is_emergency header (yes or blank) and a deprecated, always blank retro_overdue", () => {
    const s = src("lib/export/audit-pack.ts");
    expect(s).toMatch(/"tier", "is_emergency"/);
    expect(s).toMatch(/retro_overdue: ""/);
    expect(s).not.toContain("isRetroOverdue");
  });
});
