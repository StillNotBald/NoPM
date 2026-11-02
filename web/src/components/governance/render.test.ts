/**
 * Server-render tests for the four-eyes UI: the right controls are offered (or
 * withheld) for what the server decided, and the one shared note carries the
 * rule. There is no DOM environment in this repo (vitest is node-only), so
 * components render to static markup with `react-dom/server`; effects do not
 * run, which is fine here — these pin structure and copy.
 */
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/app-shell", () => ({
  useInspector: () => ({ open: () => {}, close: () => {} }),
}));

import { ApprovalActions } from "@/components/approvals/actions";
import { DecisionPanel } from "@/components/change-control/change-detail";
import { ApprovalInlineAction, ChangeInlineAction } from "@/components/review/inline-action";
import type { ReviewItem } from "@/lib/review/gather";
import { DecisionRefusal } from "./decision-refusal";
import { FourEyesNote, ruleText, type DecideState } from "./four-eyes-note";
import { describeRefusal } from "./refusal";
import { ShowOncePanel } from "./show-once-panel";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

const ALLOWED: DecideState = { canDecide: true, block: null, canWithdraw: false };
const MINE: DecideState = { canDecide: false, block: "you_raised", canWithdraw: true };
const MY_TOKEN: DecideState = { canDecide: false, block: "your_token_raised", canWithdraw: false };

describe("FourEyesNote", () => {
  it("states the rule in plain words, including the token clause, with no API jargon", () => {
    const markup = html(createElement(FourEyesNote));
    expect(markup).toContain("A different person from the one who raised it must decide");
    expect(markup).toContain("A token counts as the person who created it");
    expect(markup).not.toMatch(/API layer|403/);
    expect(ruleText("submitted")).toContain("who submitted it");
  });

  it("tells a blocked viewer why, using the shared sentence", () => {
    for (const block of ["you_raised", "your_token_raised"] as const) {
      const markup = html(createElement(FourEyesNote, { block }));
      expect(markup).toContain("You raised this (or your token did)");
      expect(markup).toContain("a different person must decide.");
    }
    expect(html(createElement(FourEyesNote, { block: "your_token_raised" }))).toContain(
      "a token counts as the person who created it",
    );
    expect(html(createElement(FourEyesNote, { block: "no_scope" }))).toContain("view this, not decide it");
  });

  it("is a labelled note region in its box form", () => {
    expect(html(createElement(FourEyesNote))).toContain('role="note"');
    expect(html(createElement(FourEyesNote, { variant: "quiet" }))).not.toContain('role="note"');
  });
});

describe("ApprovalActions", () => {
  const render = (decide: DecideState) =>
    html(createElement(ApprovalActions, { requestId: "dr-1", decide, subject: "task “Cutover plan”" }));

  it("offers Approve and Reject, named for the record, when the viewer can decide", () => {
    const markup = render(ALLOWED);
    expect(markup).toContain('aria-label="Approve deletion of task “Cutover plan”"');
    expect(markup).toContain('aria-label="Reject deletion of task “Cutover plan”"');
    expect(markup).not.toContain("a different person must decide");
  });

  it("never offers Approve / Reject for a request the viewer raised: the note replaces them, Withdraw stays", () => {
    const markup = render(MINE);
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Reject<");
    expect(markup).toContain("You raised this (or your token did)");
    expect(markup).toContain("Withdraw");
  });

  it("a request raised through the viewer's own token: the note, and no Withdraw (only the token can)", () => {
    const markup = render(MY_TOKEN);
    expect(markup).not.toContain(">Approve<");
    expect(markup).toContain("a token counts as the person who created it");
    expect(markup).not.toContain("Withdraw");
  });
});

describe("DecisionPanel (change request)", () => {
  it("replaces the form with the note when the viewer cannot decide", () => {
    const markup = html(createElement(DecisionPanel, { crId: "cr-1", onDecided: noop, decide: MY_TOKEN }));
    expect(markup).toContain("You raised this (or your token did)");
    expect(markup).not.toContain("Submit Decision");
  });

  it("offers a labelled decision group and a required rationale when the viewer can decide", () => {
    const markup = html(createElement(DecisionPanel, { crId: "cr-1", onDecided: noop, decide: ALLOWED }));
    expect(markup).toContain("<legend");
    expect(markup.match(/type="radio"/g)?.length).toBe(3);
    expect(markup).toContain("Rationale (required)");
    expect(markup).toContain('aria-required="true"');
    expect(markup).toMatch(/<label for="([^"]+)"[^>]*>Rationale/);
    expect(markup).toContain("Submit Decision");
  });
});

describe("DecisionRefusal", () => {
  it("is a focusable live alert that offers refresh only for a stale record", () => {
    const stale = describeRefusal(Object.assign(new Error("Request already decided"), { code: "already_decided" }), "x");
    const markup = html(createElement(DecisionRefusal, { refusal: stale, onBack: noop, onRefresh: noop }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("Already decided");
    expect(markup).toContain("Refresh");
    expect(markup).toContain("Back");

    const self = describeRefusal(Object.assign(new Error("Self-approval is not allowed"), { code: "self_approval" }), "x");
    const selfMarkup = html(createElement(DecisionRefusal, { refusal: self, onBack: noop, onRefresh: noop }));
    expect(selfMarkup).toContain("A different person must decide");
    expect(selfMarkup).not.toContain("Refresh");
  });
});

describe("ShowOncePanel", () => {
  it("names the secret, says it is shown once, and waits for 'I've saved it'", () => {
    // children are passed as createElement's third argument; the cast satisfies the required `children` prop type
    const props = { heading: "Your new token", onDismiss: noop } as ComponentProps<typeof ShowOncePanel>;
    const markup = html(createElement(ShowOncePanel, props, createElement("code", null, "npm_secret")));
    expect(markup).toContain("<section");
    expect(markup).toMatch(/aria-labelledby="[^"]+"/);
    expect(markup).toMatch(/aria-describedby="[^"]+"/);
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("Your new token");
    expect(markup).toContain("Shown once. Copy it now.");
    expect(markup).toContain("npm_secret");
    expect(markup).toContain("I&#x27;ve saved it");
  });
});

// ── review-queue inspectors ───────────────────────────────────────────────────

const base: ReviewItem = {
  id: "x-1",
  kind: "approval",
  title: "Delete task: Cutover plan",
  ageDays: 3,
  href: "/approvals",
  actionLabel: "Approve / reject",
};

describe("ApprovalInlineAction", () => {
  const item = (decide?: DecideState): ReviewItem => ({
    ...base,
    targetType: "task",
    targetId: "7c1f0b3e-1111-4222-8333-444455556666",
    targetName: "Cutover plan",
    targetProject: "Apollo",
    requestedByLabel: "maker (agent)",
    deletionReason: "Superseded by revised plan",
    decide,
  });

  it("puts the record's name and project beside the decision, with the id only as a footnote", () => {
    const markup = html(createElement(ApprovalInlineAction, { item: item(ALLOWED) }));
    expect(markup).toContain("Cutover plan");
    expect(markup).toContain("Apollo");
    expect(markup).toContain("maker (agent)");
    expect(markup).toContain("Superseded by revised plan");
    expect(markup).toContain("Record ID");
    expect(markup).toContain('aria-label="Approve deletion of task “Cutover plan”"');
  });

  it("withholds Approve / Reject when the viewer raised it through their token", () => {
    const markup = html(createElement(ApprovalInlineAction, { item: item(MY_TOKEN) }));
    expect(markup).toContain("You raised this (or your token did)");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Reject<");
  });

  it("points the person who raised it directly at Approvals to withdraw", () => {
    const markup = html(createElement(ApprovalInlineAction, { item: item(MINE) }));
    expect(markup).toContain("withdraw it from");
    expect(markup).toContain('href="/approvals"');
  });

  it("falls back to the old behaviour when no verdict was supplied", () => {
    expect(html(createElement(ApprovalInlineAction, { item: item(undefined) }))).toContain(">Approve<");
  });
});

describe("ChangeInlineAction", () => {
  const item = (decide?: DecideState): ReviewItem => ({
    ...base,
    kind: "change",
    title: "Add SSO",
    project: "Apollo",
    href: "/change-control?cr=cr-1",
    crStatus: "under_review",
    change: {
      reference: "CR-7",
      priority: "high",
      category: "scope",
      requestedBy: "Jo Requester",
      impactSummary: "Two extra sprints",
      impactScheduleDays: 14,
      impactCost: 8000,
      description: "Enterprise customers ask for it.",
      raisedAt: "2026-10-10T00:00:00Z",
      targetDate: null,
      updatedAt: "2026-10-14T01:02:03.456+00:00",
      projectId: "p-1",
    },
    decide,
  });

  it("shows who asked and what it costs, not just a title", () => {
    const markup = html(createElement(ChangeInlineAction, { item: item(ALLOWED) }));
    for (const text of ["Jo Requester", "Two extra sprints", "+14 days", "8,000.00", "Enterprise customers ask for it.", "CR-7", "Under Review"]) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain("under_review");
    expect(markup).toContain('href="/change-control?cr=cr-1"');
    expect(markup).toContain("Four-eyes:");
    expect(markup).toContain("Submit Decision");
  });

  it("states four-eyes (it used to say nothing) and withholds the form when the viewer raised it", () => {
    const markup = html(createElement(ChangeInlineAction, { item: item(MINE) }));
    expect(markup).toContain("You raised this (or your token did)");
    expect(markup).not.toContain("Submit Decision");
  });
});
