import { describe, it, expect, vi, afterEach } from "vitest";
import type { LinkOutcome } from "@/lib/integrations/identity";
import type { InboundOutcome } from "@/lib/integrations/types";
import { CARD_DEADLINE_MS, handleCardAction, handleLarkPayload, type LarkHandlerContext } from "./handlers";
import {
  FIXTURE_APP_URL,
  FIXTURE_OPEN_ID,
  FIXTURE_TENANT,
  cardActionEvent,
  fakeHandlerDeps,
  fixtureConfig,
  fixtureConnector,
  fixtureSecrets,
  messageEvent,
  urlVerificationBody,
} from "./fixtures";
import type { LarkEnvelope } from "./verify";

function ctx(over: Partial<LarkHandlerContext> = {}): LarkHandlerContext {
  return { connector: fixtureConnector(), secrets: fixtureSecrets(), appUrl: FIXTURE_APP_URL, ...over };
}

const env = (body: unknown) => body as LarkEnvelope;

afterEach(() => vi.useRealTimers());

describe("card.action.trigger", () => {
  it("approve: hands the verified identity + token to the hub and replies with a success toast and the decided card", async () => {
    const { deps } = fakeHandlerDeps();
    const res = await handleCardAction(ctx(), env(cardActionEvent({ eventId: "evt_1", value: { t: "tok-1", a: "approve" } })), deps);

    expect(deps.handleApprovalAction).toHaveBeenCalledTimes(1);
    expect(deps.handleApprovalAction).toHaveBeenCalledWith({
      connector: expect.objectContaining({ id: fixtureConnector().id }),
      externalEventId: "evt_1",
      externalTenant: FIXTURE_TENANT,
      externalUserId: FIXTURE_OPEN_ID,
      actionToken: "tok-1",
      action: "approve",
      note: null,
    });
    expect(res.toast).toEqual({ type: "success", content: "Approved. Recorded in NoPM." });
    expect(res.card?.type).toBe("raw");
    const card = res.card?.data as { schema: string; header: { template: string }; body: { elements: { tag: string }[] } };
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("green");
    expect(JSON.stringify(card)).not.toContain('"button"');
    expect(JSON.stringify(card)).toContain("Delete task Alpha");
    expect(JSON.stringify(card)).toContain("2026-10-16 09:30 UTC");
  });

  it("reject: passes the trimmed reason as the note", async () => {
    const { deps } = fakeHandlerDeps({
      handleApprovalAction: vi.fn(async (): Promise<InboundOutcome> => ({
        status: "decided",
        action: "reject",
        ref: { kind: "change_request", id: "cr-1" },
        title: "CR-12",
        newStatus: "rejected",
      })),
    });
    const res = await handleCardAction(
      ctx(),
      env(cardActionEvent({ value: { t: "tok-2", a: "reject" }, formValue: { reason: "  Out of budget\u0000 " } })),
      deps,
    );
    expect(deps.handleApprovalAction).toHaveBeenCalledWith(expect.objectContaining({ action: "reject", note: "Out of budget" }));
    expect(res.toast).toEqual({ type: "success", content: "Rejected. Recorded in NoPM." });
    expect((res.card?.data as { header: { template: string } }).header.template).toBe("red");
  });

  it("reject without a reason is refused BEFORE the hub (the single-use token is not burned)", async () => {
    const { deps } = fakeHandlerDeps();
    for (const formValue of [undefined, {}, { reason: "" }, { reason: "   " }, { reason: 7 }]) {
      const res = await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok", a: "reject" }, formValue: formValue as Record<string, unknown> })), deps);
      expect(res.toast.type).toBe("warning");
      expect(res.toast.content).toContain("reason");
    }
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it("rejects an over-long reason before the hub", async () => {
    const { deps } = fakeHandlerDeps();
    const res = await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok", a: "reject" }, formValue: { reason: "x".repeat(501) } })), deps);
    expect(res.toast.type).toBe("warning");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it("ignores a note on approve", async () => {
    const { deps } = fakeHandlerDeps();
    await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok", a: "approve" }, formValue: { reason: "sneaky" } })), deps);
    expect(deps.handleApprovalAction).toHaveBeenCalledWith(expect.objectContaining({ note: null }));
  });

  it.each<[string, InboundOutcome, string, string]>([
    ["unlinked", { status: "unlinked" }, "error", "not linked"],
    ["expired", { status: "expired" }, "warning", "expired"],
    ["not_recipient", { status: "not_recipient" }, "error", "not sent to you"],
    ["self_approval", { status: "self_approval" }, "error", "four-eyes"],
    ["already_decided", { status: "already_decided" }, "info", "Already decided"],
    ["forbidden", { status: "forbidden", message: "Only admins can do this." }, "error", "Only admins can do this."],
    ["invalid", { status: "invalid", message: "That request no longer exists." }, "warning", "no longer exists"],
    ["error", { status: "error", message: "boom" }, "error", "Could not record"],
  ])("maps the %s outcome to a toast and leaves the card alone", async (_name, outcome, type, text) => {
    const { deps } = fakeHandlerDeps({ handleApprovalAction: vi.fn(async () => outcome) });
    const res = await handleCardAction(ctx(), env(cardActionEvent()), deps);
    expect(res.toast.type).toBe(type);
    expect(res.toast.content).toContain(text);
    expect(res.card).toBeUndefined();
  });

  it("never throws: a hub exception becomes an error toast and is logged without secrets", async () => {
    const { deps } = fakeHandlerDeps({
      handleApprovalAction: vi.fn(async () => {
        throw new Error("db exploded");
      }),
    });
    const res = await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok-secret", a: "approve" } })), deps);
    expect(res.toast.type).toBe("error");
    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("approval action threw");
    expect(logged).not.toContain("tok-secret");
  });

  it("is switched off by the connector's approvals toggle", async () => {
    const { deps } = fakeHandlerDeps();
    const res = await handleCardAction(
      ctx({ connector: fixtureConnector({ config: fixtureConfig({ approvals: { enabled: false } }) }) }),
      env(cardActionEvent()),
      deps,
    );
    expect(res.toast.type).toBe("warning");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it.each<[string, Parameters<typeof cardActionEvent>[0]]>([
    ["no operator open_id", { openId: null }],
    ["no tenant anywhere", { tenantKey: null }],
  ])("refuses a click with %s", async (_name, over) => {
    const { deps } = fakeHandlerDeps();
    const body = cardActionEvent(over);
    if (over?.tenantKey === null) delete (body.header as { tenant_key?: string }).tenant_key;
    const res = await handleCardAction(ctx(), env(body), deps);
    expect(res.toast.type).toBe("error");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it("falls back to the header tenant when the operator carries none", async () => {
    const { deps } = fakeHandlerDeps();
    await handleCardAction(ctx(), env(cardActionEvent({ tenantKey: null })), deps);
    expect(deps.handleApprovalAction).toHaveBeenCalledWith(expect.objectContaining({ externalTenant: FIXTURE_TENANT }));
  });

  it("refuses a click without an event id", async () => {
    const { deps } = fakeHandlerDeps();
    const body = cardActionEvent();
    delete (body.header as { event_id?: string }).event_id;
    expect((await handleCardAction(ctx(), env(body), deps)).toast.type).toBe("error");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it.each([
    ["a string value", "approve"],
    ["no token", { a: "approve" }],
    ["an empty token", { t: "", a: "approve" }],
    ["an oversized token", { t: "x".repeat(257), a: "approve" }],
    ["an unknown action", { t: "tok", a: "delete" }],
    ["an extra-only payload", { approval_id: "123", a: "approve" }],
    ["null", null],
  ])("treats %s as an out-of-date card", async (_name, value) => {
    const { deps } = fakeHandlerDeps();
    const res = await handleCardAction(ctx(), env(cardActionEvent({ value })), deps);
    expect(res.toast.type).toBe("warning");
    expect(res.toast.content).toContain("out of date");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it("a redelivered callback re-sends the SAME event id (idempotency is the hub's job)", async () => {
    const { deps } = fakeHandlerDeps();
    const body = env(cardActionEvent({ eventId: "evt_dup" }));
    await handleCardAction(ctx(), body, deps);
    await handleCardAction(ctx(), body, deps);
    const ids = (deps.handleApprovalAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].externalEventId);
    expect(ids).toEqual(["evt_dup", "evt_dup"]);
  });

  it("answers before the platform's 3 s deadline and keeps the slow decision alive in the background", async () => {
    vi.useFakeTimers();
    let finish!: (o: InboundOutcome) => void;
    const slow = new Promise<InboundOutcome>((resolve) => (finish = resolve));
    const { deps } = fakeHandlerDeps({ handleApprovalAction: vi.fn(() => slow) });
    const background = vi.fn();

    const pending = handleCardAction(ctx({ background }), env(cardActionEvent()), deps);
    await vi.advanceTimersByTimeAsync(CARD_DEADLINE_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    const res = await pending;
    expect(res.toast.type).toBe("info");
    expect(res.card).toBeUndefined();
    expect(background).toHaveBeenCalledTimes(1);
    expect(CARD_DEADLINE_MS).toBeLessThan(3000);

    finish({ status: "already_decided" });
    await expect(background.mock.calls[0][0]).resolves.toEqual({ status: "already_decided" });
  });
});

describe("handleLarkPayload", () => {
  it("answers a url_verification handshake with its challenge", async () => {
    const { deps } = fakeHandlerDeps();
    expect(await handleLarkPayload(ctx(), env(urlVerificationBody()), deps)).toEqual({
      status: 200,
      body: { challenge: "challenge-fixture-abc" },
    });
  });

  it("routes card callbacks and returns the toast body", async () => {
    const { deps } = fakeHandlerDeps();
    const res = await handleLarkPayload(ctx(), env(cardActionEvent()), deps);
    expect(res.status).toBe(200);
    expect((res.body as { toast: { type: string } }).toast.type).toBe("success");
  });

  it("acknowledges unknown event types without doing anything", async () => {
    const { deps } = fakeHandlerDeps();
    const body = { schema: "2.0", header: { event_id: "e", event_type: "im.message.message_read_v1", token: "x" }, event: {} };
    expect(await handleLarkPayload(ctx(), env(body), deps)).toEqual({ status: 200, body: {} });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("ignores a legacy 1.0 event and says why in the log", async () => {
    const { deps, sent } = fakeHandlerDeps();
    const legacy = { type: "event_callback", token: "x", event: { type: "message", open_id: "ou_1" } };
    expect(await handleLarkPayload(ctx(), env(legacy), deps)).toEqual({ status: 200, body: {} });
    expect(sent).toHaveLength(0);
    expect(deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("legacy v1"), expect.anything());
  });

  it("ignores an event addressed to a different app", async () => {
    const { deps, sent } = fakeHandlerDeps();
    const res = await handleLarkPayload(ctx(), env(messageEvent({ appId: "cli_someone_else" })), deps);
    expect(res).toEqual({ status: 200, body: {} });
    expect(sent).toHaveLength(0);
    expect(deps.claimEvent).not.toHaveBeenCalled();
  });

  it("treats a message or card event with NO app id as a mismatch, not a pass (F6)", async () => {
    const noAppId = (body: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const copy = JSON.parse(JSON.stringify(body));
      delete copy.header.app_id;
      return copy;
    };
    const message = fakeHandlerDeps();
    expect(await handleLarkPayload(ctx(), env(noAppId(messageEvent({ text: "help" }))), message.deps)).toEqual({ status: 200, body: {} });
    expect(message.sent).toHaveLength(0);
    expect(message.deps.claimEvent).not.toHaveBeenCalled();

    const card = fakeHandlerDeps();
    expect(await handleLarkPayload(ctx(), env(noAppId(cardActionEvent({ value: { t: "tok", a: "approve" } }))), card.deps)).toEqual({ status: 200, body: {} });
    expect(card.deps.handleApprovalAction).not.toHaveBeenCalled();
    expect(card.deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("different app"), expect.anything());
  });

  it("still accepts the same events when they carry the connector's own app id", async () => {
    const { deps } = fakeHandlerDeps();
    await handleLarkPayload(ctx(), env(cardActionEvent({ value: { t: "tok", a: "approve" } })), deps);
    expect(deps.handleApprovalAction).toHaveBeenCalledTimes(1);
  });
});

describe("bot DMs (im.message.receive_v1)", () => {
  const run = async (text: string, over: Parameters<typeof messageEvent>[0] = {}, deps = fakeHandlerDeps()) => {
    const res = await handleLarkPayload(ctx(), env(messageEvent({ text, ...over })), deps.deps);
    return { res, ...deps };
  };
  const titleOf = (msg: { body: Record<string, unknown> }) => (msg.body.header as { title: { content: string } }).title.content;

  it("acknowledges immediately and replies in the background when a background hook is supplied", async () => {
    const { deps, sent } = fakeHandlerDeps();
    const background = vi.fn();
    const res = await handleLarkPayload(ctx({ background }), env(messageEvent({ text: "help" })), deps);
    expect(res).toEqual({ status: 200, body: {} });
    expect(background).toHaveBeenCalledTimes(1);
    await background.mock.calls[0][0];
    expect(sent).toHaveLength(1);
  });

  it("help: DMs the help card to the sender's open_id", async () => {
    const { sent } = await run("help");
    expect(sent).toHaveLength(1);
    expect(sent[0].receiveIdType).toBe("open_id");
    expect(sent[0].receiveId).toBe(FIXTURE_OPEN_ID);
    expect(titleOf(sent[0])).toBe("NoPM bot");
  });

  it("unknown text and non-text messages get the help card", async () => {
    expect(titleOf((await run("approve everything")).sent[0])).toBe("NoPM bot");
    const image = await run("", { messageType: "image", content: JSON.stringify({ image_key: "k" }) });
    expect(titleOf(image.sent[0])).toBe("NoPM bot");
  });

  it("ignores group chats, bot senders and duplicates", async () => {
    expect((await run("help", { chatType: "group" })).sent).toHaveLength(0);
    expect((await run("help", { senderType: "app" })).sent).toHaveLength(0);
    const dup = fakeHandlerDeps({ claimEvent: vi.fn(async () => false) });
    expect((await run("help", {}, dup)).sent).toHaveLength(0);
  });

  it("dedupes on the MESSAGE id (Lark re-pushes an unacknowledged message under a new event id)", async () => {
    const d = fakeHandlerDeps();
    await run("help", { eventId: "evt_abc", messageId: "om_abc" }, d);
    await run("help", { eventId: "evt_def_retry", messageId: "om_abc" }, d);
    expect(d.deps.claimEvent).toHaveBeenNthCalledWith(1, fixtureConnector().id, "om_abc");
    expect(d.deps.claimEvent).toHaveBeenNthCalledWith(2, fixtureConnector().id, "om_abc");
  });

  it("falls back to the event id when the message carries no id", async () => {
    const d = fakeHandlerDeps();
    await run("help", { eventId: "evt_abc", messageId: null }, d);
    expect(d.deps.claimEvent).toHaveBeenCalledWith(fixtureConnector().id, "evt_abc");
  });

  it("link: passes the code + verified identity to the hub and confirms", async () => {
    const d = fakeHandlerDeps();
    const { sent } = await run("link npl-abcd-2345", { eventId: "evt_link", messageId: "om_link" }, d);
    expect(d.deps.consumeLinkCode).toHaveBeenCalledWith({
      connector: expect.objectContaining({ id: fixtureConnector().id }),
      rawCode: "NPL-ABCD-2345",
      externalTenant: FIXTURE_TENANT,
      externalUserId: FIXTURE_OPEN_ID,
      externalUnionId: "on_fixture_union_1",
      externalEventId: "om_link", // the dedupe key: the Lark message id
    });
    expect(titleOf(sent[0])).toBe("Account linked");
    expect(JSON.stringify(sent[0].body)).toContain("Sam Approver");
  });

  it.each([
    [{ status: "linked", profileLabel: "Sam", alreadyLinked: true }, "Already linked"],
    [{ status: "invalid_code" }, "Code not recognised"],
    [{ status: "already_used" }, "Code already used"],
    [{ status: "expired" }, "Code expired"],
    [{ status: "conflict", message: "This account is already linked to another NoPM user." }, "Could not link"],
    [{ status: "paused" }, "Integration paused"],
    [{ status: "forbidden", message: "This Lark account belongs to a different Lark tenant." }, "Wrong Lark workspace"],
    [{ status: "error", message: "x" }, "Could not link"],
  ] as const)("link outcome %j -> %s card", async (outcome, title) => {
    const d = fakeHandlerDeps({ consumeLinkCode: vi.fn(async () => outcome) });
    const { sent } = await run("link NPL-ABCD-2345", {}, d);
    expect(titleOf(sent[0])).toBe(title);
  });

  it("link without a code explains the usage and does not call the hub", async () => {
    const d = fakeHandlerDeps();
    const { sent } = await run("link", {}, d);
    expect(titleOf(sent[0])).toBe("Link code needed");
    expect(d.deps.consumeLinkCode).not.toHaveBeenCalled();
  });

  it("never logs the code or the message text", async () => {
    const d = fakeHandlerDeps({
      consumeLinkCode: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await run("link NPL-ABCD-2345", {}, d);
    const logged = JSON.stringify((d.deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("lark message event failed");
    expect(logged).not.toContain("NPL-ABCD-2345");
  });

  it("approvals: reports the counts, or why there are none", async () => {
    const ok = await run("approvals");
    expect(titleOf(ok.sent[0])).toBe("Waiting for you");
    expect(JSON.stringify(ok.sent[0].body)).toContain("Deletion requests:** 2");

    const unlinked = await run("approvals", {}, fakeHandlerDeps({ countPending: vi.fn(async () => ({ status: "unlinked" as const })) }));
    expect(titleOf(unlinked.sent[0])).toBe("Account not linked");

    const notApprover = await run("approvals", {}, fakeHandlerDeps({ countPending: vi.fn(async () => ({ status: "not_approver" as const })) }));
    expect(titleOf(notApprover.sent[0])).toBe("Nothing to decide");

    const failed = await run("approvals", {}, fakeHandlerDeps({ countPending: vi.fn(async () => ({ status: "error" as const })) }));
    expect(titleOf(failed.sent[0])).toBe("Could not load approvals");
  });

  it("survives a failed reply: logs a warning and never throws", async () => {
    const d = fakeHandlerDeps({ send: vi.fn(async () => ({ ok: false as const, retryable: true, error: "rate limited" })) });
    const { res } = await run("help", {}, d);
    expect(res.status).toBe(200);
    const logged = JSON.stringify((d.deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain("lark bot reply failed");
  });
});

describe("a card tap on a request that was edited", () => {
  it("answers with a warning toast that says nothing was decided, and no replacement card", async () => {
    const { deps } = fakeHandlerDeps({ handleApprovalAction: vi.fn(async (): Promise<InboundOutcome> => ({ status: "changed" })) });
    const res = await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok-stale", a: "approve" } })), deps);
    expect(res.toast.type).toBe("warning");
    expect(res.toast.content).toMatch(/changed after the card was sent/i);
    expect(res.toast.content).toMatch(/nothing was decided/i);
    expect(res.card).toBeUndefined();
  });

  it("is the same for a reject (the reason the person typed is not recorded anywhere)", async () => {
    const { deps } = fakeHandlerDeps({ handleApprovalAction: vi.fn(async (): Promise<InboundOutcome> => ({ status: "changed" })) });
    const res = await handleCardAction(
      ctx(),
      env(cardActionEvent({ value: { t: "tok-stale", a: "reject" }, formValue: { reason: "too big" } })),
      deps,
    );
    expect(res.toast.type).toBe("warning");
    expect(res.card).toBeUndefined();
  });
});

describe("link command — throttled and displaced accounts", () => {
  const run = async (text: string, deps: ReturnType<typeof fakeHandlerDeps>) => {
    await handleLarkPayload(ctx(), env(messageEvent({ text })), deps.deps);
    return deps;
  };
  const titleOf = (msg: { body: Record<string, unknown> }) => (msg.body.header as { title: { content: string } }).title.content;

  it("tells a sender who is guessing to wait, in plain words", async () => {
    const d = fakeHandlerDeps({ consumeLinkCode: vi.fn(async (): Promise<LinkOutcome> => ({ status: "rate_limited", retryAfterSeconds: 400 })) });
    const { sent } = await run("link NPL-ABCD-2345", d);
    expect(sent).toHaveLength(1);
    expect(titleOf(sent[0])).toBe("Too many attempts");
    expect(JSON.stringify(sent[0].body)).toMatch(/wait a few minutes/i);
  });

  it("confirms the new account FIRST, then tells every account that just lost the link", async () => {
    const d = fakeHandlerDeps({
      consumeLinkCode: vi.fn(
        async (): Promise<LinkOutcome> => ({
          status: "linked",
          profileLabel: "Sam Approver",
          alreadyLinked: false,
          displaced: [
            { externalTenant: FIXTURE_TENANT, externalUserId: "ou_old_account_1" },
            { externalTenant: FIXTURE_TENANT, externalUserId: "ou_old_account_2" },
          ],
        }),
      ),
    });
    const { sent } = await run("link NPL-ABCD-2345", d);

    expect(sent.map((m) => m.receiveId)).toEqual([FIXTURE_OPEN_ID, "ou_old_account_1", "ou_old_account_2"]);
    expect(titleOf(sent[0])).toBe("Account linked");
    for (const notice of sent.slice(1)) {
      expect(notice.receiveIdType).toBe("open_id");
      expect(titleOf(notice)).toBe("This Lark account was unlinked");
      expect(JSON.stringify(notice.body)).toMatch(/not you/i);
    }
  });

  it("does not let a failed notice to the old account break the reply to the new one", async () => {
    const d = fakeHandlerDeps({
      consumeLinkCode: vi.fn(
        async (): Promise<LinkOutcome> => ({
          status: "linked",
          profileLabel: "Sam Approver",
          alreadyLinked: false,
          displaced: [{ externalTenant: FIXTURE_TENANT, externalUserId: "ou_old_account_1" }],
        }),
      ),
    });
    const base = d.deps.send;
    d.deps.send = vi.fn(async (c, s, m) => {
      if (m.receiveId === "ou_old_account_1") throw new Error("socket hang up");
      return base(c, s, m);
    });
    const { sent } = await run("link NPL-ABCD-2345", d);
    expect(sent).toHaveLength(1);
    expect(titleOf(sent[0])).toBe("Account linked");
    expect(d.deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("displaced"), expect.anything());
  });

  it("sends no extra notice for an ordinary first link or a re-confirmation", async () => {
    const first = fakeHandlerDeps();
    expect((await run("link NPL-ABCD-2345", first)).sent).toHaveLength(1);
    const again = fakeHandlerDeps({
      consumeLinkCode: vi.fn(async (): Promise<LinkOutcome> => ({ status: "linked", profileLabel: "Sam", alreadyLinked: true })),
    });
    expect((await run("link NPL-ABCD-2345", again)).sent).toHaveLength(1);
  });
});

describe("reject reasons are cleaned before they reach the audit trail", () => {
  it("strips control and bidirectional characters but keeps ordinary text, accents and emoji", async () => {
    const { deps } = fakeHandlerDeps();
    const reason = "  Too ‮expensive‬ ⁦now⁩‏, café 😀\u0000 ";
    await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok-bidi", a: "reject" }, formValue: { reason } })), deps);
    expect(deps.handleApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reject", note: "Too expensive now, café 😀" }),
    );
  });

  it("refuses a reason that is nothing but bidirectional controls, before the hub is called", async () => {
    const { deps } = fakeHandlerDeps();
    const res = await handleCardAction(ctx(), env(cardActionEvent({ value: { t: "tok-bidi", a: "reject" }, formValue: { reason: "‮‬" } })), deps);
    expect(res.toast.type).toBe("warning");
    expect(deps.handleApprovalAction).not.toHaveBeenCalled();
  });
});
