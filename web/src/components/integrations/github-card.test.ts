/**
 * Server-render smoke tests for the GitHub card and the task "Link PR" field (R-153). No DOM environment
 * in this repo: components render to static markup, so these pin structure and copy a person depends on.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventRow, GithubCard, REASON_LABELS, RULE_ROWS, TARGET_OPTIONS, type WorkEventRow } from "./github-card";
import { LinkPullRequest, canLinkPullRequest } from "./link-pr-field";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const NOW = Date.parse("2026-10-18T12:00:00.000Z");

const event = (over: Partial<WorkEventRow> = {}): WorkEventRow => ({
  id: "e1",
  kind: "pr_merged",
  ref: "acme/widgets#7",
  actor_login: "octo-dev",
  received_at: "2026-10-18T11:30:00.000Z",
  applied: true,
  applied_status: "In review",
  reason: "applied",
  ...over,
});

describe("GithubCard", () => {
  it("renders its loading state without throwing", () => {
    expect(html(createElement(GithubCard))).toContain("Loading GitHub");
  });

  it("offers a select for each of the four events with every status except Completed (R-160) and a 'leave as it is' choice", () => {
    expect(RULE_ROWS.map((r) => r.kind)).toEqual(["pr_opened", "pr_merged", "deploy_success", "deploy_failure"]);
    expect(TARGET_OPTIONS.map((o) => o.value)).toEqual(["unstarted", "started", "in_review", "canceled"]);
    expect(TARGET_OPTIONS.map((o) => o.label)).not.toContain("Completed");
  });

  it("has a plain reason for every outcome the webhook can record", () => {
    for (const reason of ["applied", "project_locked", "unknown_ref", "no_rule", "already_at_or_beyond", "task_canceled", "conflict", "no_linked_pr", "error"]) {
      expect(REASON_LABELS[reason], reason).toBeTruthy();
    }
  });
});

describe("EventRow", () => {
  it("shows an applied event with the status it set", () => {
    const out = html(createElement(EventRow, { event: event(), nowMs: NOW }));
    expect(out).toContain("PR merged");
    expect(out).toContain("acme/widgets#7");
    expect(out).toContain("Applied");
    expect(out).toContain("Now In review");
    expect(out).toContain("30m ago");
  });

  it("shows a skipped event with its reason, stacked on phones", () => {
    const out = html(createElement(EventRow, { event: event({ applied: false, applied_status: null, reason: "project_locked" }), nowMs: NOW }));
    expect(out).toContain("Not applied");
    expect(out).toContain("Skipped: project is locked");
    expect(out).toContain("flex-col");
  });
});

describe("LinkPullRequest", () => {
  it("offers a labelled input and a Link PR button when nothing is linked", () => {
    const out = html(createElement(LinkPullRequest, { task: { id: "t1", external_ref: null }, onChanged: () => {} }));
    expect(out).toContain('aria-label="Pull request to link"');
    expect(out).toContain("Link PR");
    expect(out).toContain("disabled");
  });

  it("shows the linked pull request with an Unlink action", () => {
    const out = html(createElement(LinkPullRequest, { task: { id: "t1", external_ref: "github:acme/widgets#7" }, onChanged: () => {} }));
    expect(out).toContain("acme/widgets#7");
    expect(out).toContain("Unlink");
  });

  it("is offered only when the task has no other system's reference", () => {
    expect(canLinkPullRequest({ external_ref: null })).toBe(true);
    expect(canLinkPullRequest({ external_ref: "github:acme/widgets#7" })).toBe(true);
    expect(canLinkPullRequest({ external_ref: "PROJ-123" })).toBe(false);
  });
});
