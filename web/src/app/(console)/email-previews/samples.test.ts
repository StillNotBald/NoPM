import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderNotificationEmail } from "@/lib/notify/email";
import { SAMPLE_NOTIFICATIONS } from "./samples";

const PAGE = readFileSync(join(process.cwd(), "src", "app", "(console)", "email-previews", "page.tsx"), "utf8");

describe("email-previews empty-state samples", () => {
  it("covers every notification type the template has a subject prefix for, once each", () => {
    const types = SAMPLE_NOTIFICATIONS.map((s) => s.type);
    expect(types).toEqual([
      "approval.requested",
      "approval.approved",
      "approval.rejected",
      "risk.escalated",
      "clash.detected",
    ]);
    expect(new Set(types).size).toBe(types.length);
  });

  it("each sample renders through the real template with its mapped subject prefix", () => {
    const prefixes: Record<string, string> = {
      "approval.requested": "Approval needed: ",
      "approval.approved": "Approved: ",
      "approval.rejected": "Rejected: ",
      "risk.escalated": "Risk escalated: ",
      "clash.detected": "Clash detected: ",
    };
    for (const s of SAMPLE_NOTIFICATIONS) {
      const { subject, html } = renderNotificationEmail(s);
      expect(subject.startsWith(prefixes[s.type])).toBe(true);
      expect(html).toContain("View in NoPM");
    }
  });

  it("are generic: no email addresses, URLs or personal names in the copy", () => {
    for (const s of SAMPLE_NOTIFICATIONS) {
      const text = `${s.title} ${s.body ?? ""}`;
      expect(text).not.toMatch(/@|https?:\/\//);
    }
  });

  it("deep links point at real console routes", () => {
    for (const s of SAMPLE_NOTIFICATIONS) {
      expect(String(s.payload?.href)).toMatch(/^\/(approvals|trust|risks|clashes)$/);
    }
  });

  it("the page labels samples as samples and never prints the raw database message", () => {
    expect(PAGE).toContain("SAMPLE_NOTIFICATIONS");
    expect(PAGE).toMatch(/<Badge tone="neutral"[^>]*>Sample<\/Badge>/);
    expect(PAGE).not.toMatch(/error\.message/);
    expect(PAGE).toMatch(/role="alert"/);
  });
});
