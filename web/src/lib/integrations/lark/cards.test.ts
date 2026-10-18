import { describe, it, expect } from "vitest";
import type { ApprovalDecidedEvent, ApprovalEvent, DigestData } from "@/lib/integrations/types";
import {
  MAX_REJECT_REASON,
  buildApprovalRequestCard,
  buildBacklogNoticeCard,
  buildChangedUpdateCard,
  buildDecidedCard,
  buildDecisionUpdateCard,
  buildDigestCard,
  buildHelpCard,
  buildLinkConfirmationCard,
  buildLinkReplacedCard,
  buildNoticeCard,
  buildPendingApprovalsCard,
  buildUnlinkedCard,
  cardCallbackResponse,
  deepLinkFor,
  escapeLarkMd,
  isUpdatableCard,
  normalizeAppUrl,
  oneLine,
  resolveAppUrl,
  type LarkCard,
} from "./cards";

const APP = "https://nopm.example.test";
const TOKEN = "npa_raw-action-token-for-tests";
const ID = "44444444-4444-4444-8444-444444444444";

const deletionEvent: ApprovalEvent = {
  workspaceId: "w1",
  kind: "task_deletion",
  id: ID,
  title: 'Delete task "Migrate billing DB"',
  summary: "Duplicate of the cutover task; safe to remove.",
  projectId: "p1",
  projectName: "Platform Cutover",
  requestedByLabel: "Riley Requester",
  requesterPrincipalId: "u-requester",
};

const changeEvent: ApprovalEvent = {
  ...deletionEvent,
  kind: "change_request",
  title: "CR-12: extend UAT by one week",
  summary: null,
};

const digest: DigestData = {
  workspaceName: "Acme Programme Office",
  generatedAt: "2026-10-16T09:30:00.000Z",
  appUrl: APP,
  projects: [
    { id: "p1", name: "Platform Cutover", health: "amber", status: "active" },
    { id: "p2", name: "Data Migration", health: "green", status: "active" },
    { id: "p3", name: "Mobile Rollout", health: "red", status: "on_hold" },
    { id: "p4", name: "Legacy Retirement", health: null, status: null },
  ],
  milestonesDueSoon: [
    { id: "m1", name: "UAT sign-off", projectName: "Platform Cutover", dueDate: "2026-10-20" },
    { id: "m2", name: "Go-live", projectName: null, dueDate: "2026-10-27T00:00:00.000Z" },
  ],
  openHighRisks: 3,
  pendingApprovals: 2,
};

const decidedEvent: ApprovalDecidedEvent = {
  ...deletionEvent,
  status: "committed",
  decidedByLabel: "Sam Approver",
  channel: "ui",
};

/** Every string value in a card, depth-first. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Every element object in a card body, depth-first (descends into forms / containers). */
function elements(card: LarkCard): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const el of list as Record<string, unknown>[]) {
      out.push(el);
      walk(el.elements);
    }
  };
  walk((card.body as { elements: unknown }).elements);
  return out;
}

function buttons(card: LarkCard) {
  return elements(card).filter((e) => e.tag === "button");
}

describe("snapshots", () => {
  it("approval request: task deletion (says what Approve does)", () => {
    expect(buildApprovalRequestCard(deletionEvent, { actionToken: TOKEN, appUrl: APP })).toMatchSnapshot();
  });

  it("approval request: change request", () => {
    expect(buildApprovalRequestCard(changeEvent, { actionToken: TOKEN, appUrl: APP })).toMatchSnapshot();
  });

  it("approval request without a configured app url (no link)", () => {
    expect(buildApprovalRequestCard(changeEvent, { actionToken: TOKEN, appUrl: "" })).toMatchSnapshot();
  });

  it("decided: approved from Lark", () => {
    expect(
      buildDecidedCard({
        ref: { kind: "task_deletion", id: ID },
        title: deletionEvent.title,
        status: "committed",
        projectName: "Platform Cutover",
        requestedByLabel: "Riley Requester",
        decidedByLabel: "Sam Approver",
        channel: "lark",
        decidedAt: "2026-10-16T09:30:00.000Z",
        appUrl: APP,
      }),
    ).toMatchSnapshot();
  });

  it("decision update: rejected from the web app", () => {
    expect(buildDecisionUpdateCard({ ...decidedEvent, status: "rejected" }, { appUrl: APP, decidedAt: "2026-10-16T09:31:00.000Z" })).toMatchSnapshot();
  });

  it("weekly digest", () => {
    expect(buildDigestCard(digest)).toMatchSnapshot();
  });

  it("weekly digest, empty workspace", () => {
    expect(buildDigestCard({ ...digest, projects: [], milestonesDueSoon: [], openHighRisks: 0, pendingApprovals: 0 })).toMatchSnapshot();
  });

  it("link confirmation, help, unlinked, pending, notice", () => {
    expect(buildLinkConfirmationCard({ displayName: "Sam Approver", appUrl: APP })).toMatchSnapshot();
    expect(buildHelpCard(APP)).toMatchSnapshot();
    expect(buildUnlinkedCard(APP)).toMatchSnapshot();
    expect(buildPendingApprovalsCard({ deletions: 2, changeRequests: 1, appUrl: APP })).toMatchSnapshot();
    expect(buildPendingApprovalsCard({ deletions: 0, changeRequests: 0, appUrl: APP })).toMatchSnapshot();
    expect(buildNoticeCard({ tone: "error", title: "Could not link", lines: ["Something went wrong."], appUrl: APP })).toMatchSnapshot();
  });

  it("callback response with a replacement card", () => {
    expect(cardCallbackResponse("success", "Approved. Recorded in NoPM.", buildHelpCard(""))).toMatchSnapshot();
  });
});

describe("approval request card contract", () => {
  const card = buildApprovalRequestCard(deletionEvent, { actionToken: TOKEN, appUrl: APP });

  it("is card JSON 2.0, shared (update_multi), with a header colour and a summary", () => {
    expect(card.schema).toBe("2.0");
    expect(card.config).toMatchObject({ update_multi: true });
    expect((card.config as { summary: { content: string } }).summary.content).toContain("Migrate billing DB");
    expect((card.header as { template: string }).template).toBe("orange");
  });

  it("buttons carry ONLY { t, a }", () => {
    const [approve, reject] = buttons(card);
    expect((approve.behaviors as unknown[])[0]).toEqual({ type: "callback", value: { t: TOKEN, a: "approve" } });
    expect((reject.behaviors as unknown[])[0]).toEqual({ type: "callback", value: { t: TOKEN, a: "reject" } });
    expect(buttons(card)).toHaveLength(2);
  });

  it("puts the raw token in the two buttons and nowhere else", () => {
    expect(JSON.stringify(card).split(TOKEN)).toHaveLength(3);
  });

  it("reject is a form with a REQUIRED reason and a named submit button", () => {
    const form = elements(card).find((e) => e.tag === "form") as { name: string; elements: Record<string, unknown>[] };
    expect(form.name).toBe("reject_form");
    const input = form.elements.find((e) => e.tag === "input") as Record<string, unknown>;
    expect(input).toMatchObject({ name: "reason", required: true, input_type: "multiline_text", max_length: MAX_REJECT_REASON });
    const submit = form.elements.find((e) => e.tag === "button") as Record<string, unknown>;
    expect(submit).toMatchObject({ form_action_type: "submit", name: "reject_submit", type: "danger" });
  });

  it("says what Approve does on deletion cards only (Lark ignores `confirm` outside form-submit buttons, so no button carries one)", () => {
    const text = (c: LarkCard) => JSON.stringify(elements(c).filter((e) => e.tag === "markdown"));
    const change = buildApprovalRequestCard(changeEvent, { actionToken: TOKEN, appUrl: APP });
    expect(text(card)).toContain("Approving carries out the deletion in NoPM.");
    expect(text(change)).not.toContain("carries out the deletion");
    for (const c of [card, change]) {
      for (const b of buttons(c)) expect(b.confirm).toBeUndefined();
    }
    // the notation sits right above the Approve button it describes
    const order = elements(card).map((e) => (e.tag === "button" ? "button" : JSON.stringify(e).includes("carries out the deletion") ? "notice" : "other"));
    expect(order.indexOf("notice")).toBe(order.indexOf("button") - 1);
  });

  it("uses unique, valid element ids", () => {
    const ids = elements(card).map((e) => String(e.element_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
  });

  it("stays well under the 30 KB platform limit even with long text", () => {
    const big = buildApprovalRequestCard(
      { ...deletionEvent, title: "T".repeat(5000), summary: "S".repeat(5000), projectName: "P".repeat(5000), requestedByLabel: "R".repeat(5000) },
      { actionToken: TOKEN, appUrl: APP },
    );
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(6000);
  });
});

describe("user text cannot become markup", () => {
  const hostile = '<at id=all></at> [click](https://evil.example.test) **bold** `code` ~~x~~ # h - li > q &#60;at id=all&#62;';

  it("escapeLarkMd neutralises every markdown / tag metacharacter", () => {
    const out = escapeLarkMd(hostile, 500);
    expect(out).not.toMatch(/[<>[\]()*_~`]/);
    // `&` is escaped too, so an entity typed by the user cannot decode into a tag.
    expect(out).toContain("&#38;#60;at id=all&#38;#62;");
    expect(out).toContain("&#60;at id=all&#62;&#60;/at&#62;");
  });

  it("escapes heading / list / rule markers only where they would act (at the start)", () => {
    expect(escapeLarkMd("# Heading")).toBe("&#35; Heading");
    expect(escapeLarkMd("- item")).toBe("&#45; item");
    expect(escapeLarkMd("---")).toBe("&#45;--");
    expect(escapeLarkMd("Re-plan sprint #3")).toBe("Re-plan sprint #3");
  });

  it("approval card text elements carry no live markup from title / summary / names", () => {
    const card = buildApprovalRequestCard(
      { ...deletionEvent, title: hostile, summary: hostile, projectName: hostile, requestedByLabel: hostile },
      { actionToken: TOKEN, appUrl: APP },
    );
    const markdown = elements(card)
      .filter((e) => e.tag === "markdown")
      .map((e) => String(e.content));
    for (const content of markdown) {
      // The ONLY allowed link is the fixed "Open in NoPM" one.
      const withoutOwnLink = content.replace(/\[Open in NoPM\]\(https:\/\/nopm\.example\.test\/approvals\)/, "");
      expect(withoutOwnLink).not.toMatch(/<|\]\(/);
      expect(withoutOwnLink).not.toContain("evil.example.test)");
    }
  });

  it("digest and decided cards escape names too", () => {
    const d = buildDigestCard({
      ...digest,
      projects: [{ id: "p", name: hostile, health: "green", status: hostile }],
      milestonesDueSoon: [{ id: "m", name: hostile, projectName: hostile, dueDate: "2026-10-20" }],
    });
    const content = elements(d)
      .filter((e) => e.tag === "markdown")
      .map((e) => String(e.content))
      .join("\n")
      // the digest legitimately uses <font> dots
      .replace(/<font color=\w+>[●○]<\/font>/g, "")
      .replace(/\[Open NoPM\]\([^)]*\)/, "");
    expect(content).not.toMatch(/<|\]\(/);

    const decided = buildDecidedCard({
      ref: { kind: "change_request", id: ID },
      title: hostile,
      status: hostile,
      decidedByLabel: hostile,
      channel: hostile,
      appUrl: APP,
    });
    const text = elements(decided)
      .filter((e) => e.tag === "markdown")
      .map((e) => String(e.content))
      .join("\n")
      .replace(/\[Open in NoPM\]\([^)]*\)/, "");
    expect(text).not.toMatch(/<|\]\(/);
  });

  it("oneLine flattens newlines and strips control / zero-width characters", () => {
    expect(oneLine("a\r\nb\tc\u0000d​e", 50)).toBe("a b c d e");
    expect(oneLine("x".repeat(30), 10)).toHaveLength(10);
    expect(oneLine(null, 10)).toBe("");
  });
});

describe("decided card", () => {
  it("has no buttons or forms and says who / how / when", () => {
    const card = buildDecisionUpdateCard(decidedEvent, { appUrl: APP, decidedAt: "2026-10-16T09:30:00.000Z" });
    expect(buttons(card)).toHaveLength(0);
    expect(elements(card).some((e) => e.tag === "form")).toBe(false);
    const text = strings(card).join("\n");
    expect(text).toContain("Approved");
    expect(text).toContain("Sam Approver");
    expect(text).toContain("the NoPM web app");
    expect(text).toContain("2026-10-16 09:30 UTC");
    expect((card.header as { template: string }).template).toBe("green");
  });

  it("colours and labels each status", () => {
    const tmpl = (status: string) =>
      (buildDecidedCard({ ref: { kind: "change_request", id: ID }, title: "t", status, appUrl: APP }).header as { template: string }).template;
    expect(tmpl("approved")).toBe("green");
    expect(tmpl("committed")).toBe("green");
    expect(tmpl("rejected")).toBe("red");
    expect(tmpl("withdrawn")).toBe("grey");
    expect(tmpl("anything_else")).toBe("grey");
  });
});

describe("digest card", () => {
  it("caps long lists and says how many more there are", () => {
    const projects = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, health: "green", status: "active" }));
    const milestones = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `Milestone ${i}`, projectName: "P", dueDate: "2026-10-20" }));
    const card = buildDigestCard({ ...digest, projects, milestonesDueSoon: milestones });
    const text = strings(card).join("\n");
    expect(text).toContain("+15 more in NoPM");
    expect(text).toContain("+12 more in NoPM");
    expect(text).not.toContain("Project 24");
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(10_000);
  });

  it("pluralises the headline", () => {
    const text = strings(buildDigestCard({ ...digest, projects: [digest.projects[0]], openHighRisks: 1, pendingApprovals: 1 })).join("\n");
    expect(text).toContain("**1** project ·");
    expect(text).toContain("**1** open high risk ·");
    expect(text).toContain("**1** pending approval");
  });
});

describe("links", () => {
  it("deep-links each kind to the right console page", () => {
    expect(deepLinkFor(APP, { kind: "change_request", id: ID })).toBe(`${APP}/change-control?cr=${ID}`);
    expect(deepLinkFor(APP, { kind: "task_deletion", id: ID })).toBe(`${APP}/approvals`);
    expect(deepLinkFor(APP, { kind: "project_deletion", id: ID })).toBe(`${APP}/approvals`);
    expect(deepLinkFor("", { kind: "change_request", id: ID })).toBe("");
  });

  it("normalises the base url and refuses non-http(s) schemes", () => {
    expect(normalizeAppUrl("https://nopm.example.test/")).toBe("https://nopm.example.test");
    expect(normalizeAppUrl("https://host.example.test/nopm//")).toBe("https://host.example.test/nopm");
    expect(normalizeAppUrl("javascript:alert(1)")).toBe("");
    expect(normalizeAppUrl("not a url")).toBe("");
    expect(normalizeAppUrl(undefined)).toBe("");
  });

  it("resolveAppUrl prefers NEXT_PUBLIC_APP_URL, then the Vercel host, then dev localhost, never a guess in production", () => {
    expect(resolveAppUrl({ NEXT_PUBLIC_APP_URL: "https://pm.example.test/", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.test" })).toBe("https://pm.example.test");
    expect(resolveAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.test" })).toBe("https://x.vercel.test");
    expect(resolveAppUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(resolveAppUrl({ NODE_ENV: "production" })).toBe("");
  });

  it("omits the link element when no base url is known", () => {
    const text = strings(buildApprovalRequestCard(changeEvent, { actionToken: TOKEN, appUrl: "" })).join("\n");
    expect(text).not.toContain("Open in NoPM");
  });
});

describe("updatable (shared) cards", () => {
  it("every builder emits a 2.0 shared card the patch API accepts", () => {
    const all: LarkCard[] = [
      buildApprovalRequestCard(deletionEvent, { actionToken: TOKEN, appUrl: APP }),
      buildApprovalRequestCard(changeEvent, { actionToken: TOKEN, appUrl: "" }),
      buildDecidedCard({ ref: { kind: "change_request", id: ID }, title: "t", status: "approved", appUrl: APP }),
      buildDecisionUpdateCard(decidedEvent, { appUrl: APP }),
      buildDigestCard(digest),
      buildHelpCard(APP),
      buildUnlinkedCard(APP),
      buildLinkConfirmationCard({ appUrl: APP }),
      buildPendingApprovalsCard({ deletions: 1, changeRequests: 0, appUrl: APP }),
      buildNoticeCard({ tone: "info", title: "x", lines: [] }),
    ];
    for (const card of all) {
      expect(card.schema).toBe("2.0");
      expect((card.config as { update_multi: unknown }).update_multi).toBe(true);
      expect(isUpdatableCard(card)).toBe(true);
    }
  });

  it("a decision update replaces the request card with the same schema and still-shared config", () => {
    const request = buildApprovalRequestCard(deletionEvent, { actionToken: TOKEN, appUrl: APP });
    const update = buildDecisionUpdateCard(decidedEvent, { appUrl: APP });
    expect(update.schema).toBe(request.schema);
    expect(update.config).toMatchObject({ update_multi: true });
  });

  it("isUpdatableCard follows the documented rules", () => {
    expect(isUpdatableCard({ schema: "2.0" })).toBe(true); // 2.0 default is shared
    expect(isUpdatableCard({ schema: "2.0", config: {} })).toBe(true);
    expect(isUpdatableCard({ schema: "2.0", config: { update_multi: false } })).toBe(false);
    expect(isUpdatableCard({ config: { update_multi: true } })).toBe(true); // 1.0 must say so
    expect(isUpdatableCard({ elements: [] })).toBe(false);
    expect(isUpdatableCard({ config: { update_multi: false } })).toBe(false);
  });
});

describe("cardCallbackResponse", () => {
  it("shapes { toast, card? } as the platform expects", () => {
    expect(cardCallbackResponse("error", "Nope")).toEqual({ toast: { type: "error", content: "Nope" } });
    const withCard = cardCallbackResponse("success", "Done", buildHelpCard(""));
    expect(withCard.card?.type).toBe("raw");
    expect((withCard.card?.data as { schema: string }).schema).toBe("2.0");
  });
});

describe("buildChangedUpdateCard", () => {
  const ev = {
    workspaceId: "w",
    kind: "change_request" as const,
    id: "cr-1",
    title: "Change request CR-7: <at id=all> [x](https://evil.example)",
    requestedByLabel: "Rae",
    requesterPrincipalId: null,
    version: "2026-10-16T10:00:00.000Z",
  };

  it("is an updatable card with no buttons, no form and no token, saying the request was edited", () => {
    const card = buildChangedUpdateCard(ev, { appUrl: "https://pm.example.test" });
    const text = JSON.stringify(card);
    expect(isUpdatableCard(card)).toBe(true);
    expect(text).not.toContain('"button"');
    expect(text).not.toContain('"form"');
    expect(text).not.toContain("callback");
    expect(text).toMatch(/edited after this card was sent/);
    expect(text).toMatch(/can no longer be approved or rejected from here/);
    expect((card.header as { template: string }).template).toBe("orange");
    expect(text).toContain("https://pm.example.test/change-control?cr=cr-1");
  });

  it("escapes the title so it cannot become a mention or a link", () => {
    // the rendered markdown elements (the plain-text chat-list preview is not interpreted by the client)
    const card = buildChangedUpdateCard(ev, { appUrl: "https://pm.example.test" }) as { body: { elements: unknown[] } };
    const text = JSON.stringify(card.body.elements);
    expect(text).not.toContain("<at id=all>");
    expect(text).not.toContain("[x](https://evil.example)");
    expect(text).toContain("&#60;at id=all&#62;");
  });

  it("omits the link when no app url is configured, rather than pointing at a wrong host", () => {
    expect(JSON.stringify(buildChangedUpdateCard(ev, { appUrl: "" }))).not.toContain("Open in NoPM");
  });
});

describe("buildBacklogNoticeCard", () => {
  it("says how many are waiting, why only some cards were sent, and links to the approvals page", () => {
    const text = JSON.stringify(buildBacklogNoticeCard({ waiting: 31, limit: 20, appUrl: "https://pm.example.test" }));
    expect(text).toContain("**31** approvals are waiting for you");
    expect(text).toMatch(/at most 20 approval cards an hour/);
    expect(text).toContain("https://pm.example.test/approvals");
    expect(text).not.toContain('"button"');
  });

  it("handles one, zero and nonsense counts", () => {
    expect(JSON.stringify(buildBacklogNoticeCard({ waiting: 1, limit: 20, appUrl: "" }))).toContain("**1** approval is waiting");
    expect(JSON.stringify(buildBacklogNoticeCard({ waiting: 0, limit: 20, appUrl: "" }))).toContain("More approvals are waiting");
    expect(JSON.stringify(buildBacklogNoticeCard({ waiting: Number.NaN, limit: 20, appUrl: "" }))).toContain("More approvals are waiting");
    expect(JSON.stringify(buildBacklogNoticeCard({ waiting: 5.9, limit: 20, appUrl: "" }))).toContain("**5** approvals");
  });

  it("is updatable and links nowhere when the app url is unknown", () => {
    const card = buildBacklogNoticeCard({ waiting: 2, limit: 20, appUrl: "" });
    expect(isUpdatableCard(card)).toBe(true);
    expect(JSON.stringify(card)).not.toContain("Open approvals");
  });
});

describe("buildLinkReplacedCard", () => {
  it("warns the old account, tells it what to do if that was not the owner, and carries no action", () => {
    const card = buildLinkReplacedCard({ appUrl: "https://pm.example.test" });
    const text = JSON.stringify(card);
    expect((card.header as { title: { content: string } }).title.content).toBe("This Lark account was unlinked");
    expect(text).toMatch(/if that was not you/i);
    expect(text).toMatch(/unlink the new account/i);
    expect(text).not.toContain('"button"');
    expect(text).not.toContain("callback");
  });
});
