import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LinkOutcome } from "@/lib/integrations/identity";
import { LINK_ATTEMPTS_PER_SENDER } from "@/lib/integrations/identity";
import { ASK_TTL_MS, handleTelegramUpdate, STEP_TTL_MS, type TelegramContext } from "./handlers";
import {
  OTHER_PROFILE_ID,
  PROFILE_ID,
  callbackUpdate,
  fakeDeps,
  fixtureConnector,
  messageUpdate,
  profile,
  resetUpdateIds,
  tapData,
  type Sent,
} from "./fixtures";
import { FREE_TEXT_STUB_REPLY } from "./assistant-seam";

beforeEach(() => resetUpdateIds());

const ctx = (over: Partial<TelegramContext> = {}): TelegramContext => ({ connector: fixtureConnector(), ...over });
const say = (h: ReturnType<typeof fakeDeps>, text: string, c = ctx()) => handleTelegramUpdate(c, messageUpdate({ text }), h.deps);
const tap = (h: ReturnType<typeof fakeDeps>, data: string, c = ctx()) => handleTelegramUpdate(c, callbackUpdate({ data }), h.deps);
const last = (h: { sent: Sent[] }) => h.sent[h.sent.length - 1]?.msg;
const lastText = (h: { sent: Sent[] }) => last(h)?.text ?? "";
const allCallbackData = (h: ReturnType<typeof fakeDeps>) => [...h.sent.map((s) => s.msg), ...h.edited.map((e) => e.msg)].flatMap((m) => (m.keyboard ?? []).flat().map((b) => b.callback_data ?? ""));

describe("front door", () => {
  it("answers 200 at once and returns an empty body", async () => {
    const h = fakeDeps();
    const res = await say(h, "/0");
    expect(res).toEqual({ status: 200, body: {} });
  });

  it("ignores group chats completely: no reply, no store use", async () => {
    const h = fakeDeps();
    for (const type of ["group", "supergroup", "channel"]) {
      await handleTelegramUpdate(ctx(), messageUpdate({ text: "/1", chatType: type }), h.deps);
    }
    expect(h.sent).toHaveLength(0);
    expect(h.deps.lookupIdentity).not.toHaveBeenCalled();
  });

  it("ignores messages from bots", async () => {
    const h = fakeDeps();
    await handleTelegramUpdate(ctx(), messageUpdate({ text: "/1", isBot: true }), h.deps);
    expect(h.sent).toHaveLength(0);
  });

  it("ignores junk updates without throwing", async () => {
    const h = fakeDeps();
    for (const junk of [null, 5, {}, { update_id: "x" }, { update_id: 1 }]) {
      await expect(handleTelegramUpdate(ctx(), junk, h.deps)).resolves.toEqual({ status: 200, body: {} });
    }
    expect(h.sent).toHaveLength(0);
  });

  it("de-duplicates on update_id: a redelivered update is answered once", async () => {
    const h = fakeDeps();
    const u = messageUpdate({ text: "/0", updateId: 77 });
    await handleTelegramUpdate(ctx(), u, h.deps);
    await handleTelegramUpdate(ctx(), u, h.deps);
    expect(h.sent).toHaveLength(1);
  });

  it("runs the work through ctx.background when the host gives one", async () => {
    const h = fakeDeps();
    const bg = vi.fn();
    const res = await say(h, "/0", ctx({ background: bg }));
    expect(res.status).toBe(200);
    expect(bg).toHaveBeenCalledTimes(1);
  });

  it("an unlinked user gets the link prompt and nothing else", async () => {
    const h = fakeDeps({ identity: null });
    await say(h, "/1");
    expect(lastText(h)).toContain("not linked");
    expect(h.apiCalls).toHaveLength(0);
    await say(h, "hello there");
    expect(lastText(h)).toContain("/start CODE");
  });

  it("a paused connector answers 'turned off' and keeps pending rows", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    const rowsBefore = h.rows.size;
    await say(h, "/1", ctx({ connector: fixtureConnector({ status: "paused" }) }));
    expect(lastText(h)).toContain("turned off");
    expect([...h.rows.values()].filter((r) => r.status === "open")).toHaveLength(1);
    expect(h.rows.size).toBe(rowsBefore);
    expect(h.apiCalls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("a disabled integrations module answers 'turned off' instead of working", async () => {
    const h = fakeDeps({ integrationsEnabled: () => false });
    await say(h, "/1");
    expect(lastText(h)).toContain("turned off");
    expect(h.apiCalls).toHaveLength(0);
  });

  it("a slow-down notice when the per-user budget is spent", async () => {
    const h = fakeDeps({ rateAllowed: async () => false });
    await say(h, "/1");
    expect(lastText(h)).toContain("Slow down");
    expect(h.apiCalls).toHaveLength(0);
  });
});

describe("linking", () => {
  const outcomes: [LinkOutcome, RegExp][] = [
    [{ status: "invalid_code" }, /not valid/],
    [{ status: "already_used" }, /already used/],
    [{ status: "expired" }, /expired/],
    [{ status: "rate_limited", retryAfterSeconds: 60 }, /paused/],
    [{ status: "paused" }, /turned off/],
    [{ status: "error", message: "x" }, /Something went wrong/],
  ];

  it.each(outcomes)("maps %j to a distinct reply", async (outcome, re) => {
    const h = fakeDeps({ identity: null, consumeLinkCode: vi.fn(async () => outcome) });
    await say(h, "/start NPL-ABCD-2345");
    expect(lastText(h)).toMatch(re);
  });

  it("a good code links, tells the person and registers the per-chat menu", async () => {
    const h = fakeDeps(); // identity resolves once the link exists
    await say(h, "/start npl-abcd-2345");
    expect(h.deps.consumeLinkCode).toHaveBeenCalledWith(
      expect.objectContaining({ rawCode: "NPL-ABCD-2345", externalTenant: fixtureConnector().id, externalUserId: "1001" }),
    );
    expect(lastText(h)).toContain("Linked");
    expect(h.deps.setChatMenu).toHaveBeenCalledWith("1001", "member");
  });

  it("a code typed on its own links too (no /start needed)", async () => {
    const h = fakeDeps({ identity: null });
    await say(h, "NPL-ABCD-2345");
    expect(h.deps.consumeLinkCode).toHaveBeenCalledTimes(1);
  });

  it("/start with no code explains how to get one", async () => {
    const h = fakeDeps({ identity: null });
    await say(h, "/start");
    expect(h.deps.consumeLinkCode).not.toHaveBeenCalled();
    expect(lastText(h)).toContain("Link my account");
  });

  it("an already-linked NoPM account must unlink first", async () => {
    const { ALREADY_LINKED_MESSAGE } = await import("@/lib/integrations/identity");
    const h = fakeDeps({ identity: null, consumeLinkCode: vi.fn(async () => ({ status: "conflict", message: ALREADY_LINKED_MESSAGE }) as LinkOutcome) });
    await say(h, "/start NPL-ABCD-2345");
    expect(lastText(h)).toContain("Unlink it");
    expect(lastText(h)).not.toContain("Lark");
  });

  it("repeating the same code on a linked chat changes nothing", async () => {
    const h = fakeDeps({ consumeLinkCode: vi.fn(async () => ({ status: "linked", profileLabel: "Pat", alreadyLinked: true }) as LinkOutcome) });
    await say(h, "/start NPL-ABCD-2345");
    expect(lastText(h)).toContain("already linked");
    expect(h.deps.setChatMenu).not.toHaveBeenCalled();
  });

  it("the attempt limit is the shared one: 8 wrong tries per sender", () => {
    expect(LINK_ATTEMPTS_PER_SENDER).toBe(8);
  });

  it("never logs the code or the message text", async () => {
    const h = fakeDeps({ identity: null });
    await say(h, "/start NPL-ABCD-2345");
    expect(JSON.stringify((h.deps.log as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("ABCD");
  });
});

describe("help and role-aware menu", () => {
  it("/0 is a short card; /0 all lists everything for the role", async () => {
    const h = fakeDeps();
    await say(h, "/0");
    expect(lastText(h)).toContain("/1 My work");
    expect(lastText(h)).toContain("/0 all");
    expect(lastText(h)).not.toContain("Not available");
    await say(h, "/0 all");
    expect(lastText(h)).toContain("Typed words work too");
    expect(lastText(h)).toContain("Not available to your role: /4");
  });

  it("a viewer sees only the read-only items and cannot use the others when typed", async () => {
    const h = fakeDeps({ identity: profile({ role: "viewer" }) });
    await say(h, "/0");
    expect(lastText(h)).toContain("/1");
    expect(lastText(h)).not.toContain("/2 Add");
    await say(h, "/2");
    expect(lastText(h)).toContain("do not have access");
    await say(h, "/3");
    expect(lastText(h)).toContain("do not have access");
    expect([...h.rows.values()].filter((r) => r.kind !== "seen")).toHaveLength(0);
  });

  it("hidden typed words work, a pasted multi-line message is never a command", async () => {
    const h = fakeDeps();
    await say(h, "tasks");
    expect(lastText(h)).toContain("My work");
    await say(h, "tasks\nare piling up");
    expect(lastText(h)).toBe(FREE_TEXT_STUB_REPLY);
  });
});

describe("/1 My work", () => {
  it("lists open tasks only, overdue first marked, scoped to the person", async () => {
    const h = fakeDeps();
    await say(h, "/1");
    expect(lastText(h)).toContain("Write plan");
    expect(lastText(h)).toContain("! Write plan");
    expect(lastText(h)).not.toContain("Done thing");
    expect(h.apiCalls[0].path).toContain(`assignee_id=${PROFILE_ID}`);
    expect(h.apiCalls[0].scopes).toEqual(["task:read"]);
  });

  it("a switched-off module is explained, not attempted", async () => {
    const h = fakeDeps({ scopeEnabled: () => false });
    await say(h, "/1");
    expect(lastText(h)).toContain("turned off");
    expect(h.apiCalls).toHaveLength(0);
  });

  it("a revoked token (401) tells the person to send the command again", async () => {
    const h = fakeDeps({ api: async () => ({ status: 401, body: { error: "revoked" } }) });
    await say(h, "/1");
    expect(lastText(h)).toContain("no longer valid");
  });

  it("escapes Telegram HTML in task names", async () => {
    const h = fakeDeps({ api: async () => ({ status: 200, body: { data: [{ name: "<b>x</b> & y", status_type: "started" }] } }) });
    await say(h, "/1");
    expect(lastText(h)).toContain("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });
});

describe("/5 Project status and /6 Digest", () => {
  it("shows project cards", async () => {
    const h = fakeDeps();
    await say(h, "/5");
    expect(lastText(h)).toContain("Alpha");
  });

  it("a project the person cannot access gets the same words as one that does not exist", async () => {
    const h = fakeDeps();
    await say(h, "/5 Zzz");
    expect(lastText(h)).toBe("No access to that project, or it does not exist.");
  });

  it("/6 sends a digest; approvers also see the waiting count; /6 on is honest", async () => {
    const h = fakeDeps({ identity: profile({ role: "manager" }) });
    await say(h, "/6");
    expect(lastText(h)).toContain("1 project");
    expect(lastText(h)).toContain("1 deletion request waiting");
    await say(h, "/6 on");
    expect(lastText(h)).toContain("not available");
  });
});

describe("/2 Add (preview, confirm, one audited write)", () => {
  async function toPreview(h: ReturnType<typeof fakeDeps>, kind: "Task" | "Issue" | "Risk" = "Task", text = "Fix the thing") {
    await say(h, "/2");
    await tap(h, tapData(last(h), kind));
    expect(h.edited[h.edited.length - 1].msg.text).toContain("Send one line");
    await say(h, text);
    return last(h);
  }

  it("task: type, one line, preview, confirm: exactly one POST with only task:write", async () => {
    const h = fakeDeps();
    const card = await toPreview(h);
    expect(card?.text).toContain("Please confirm");
    expect(card?.text).toContain("Fix the thing");
    expect(h.writes()).toHaveLength(0); // nothing is written before Confirm
    await tap(h, tapData(card, "Confirm"));
    const writes = h.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/projects/p1/tasks", scopes: ["task:write"], body: { name: "Fix the thing" } });
    expect(h.edited[h.edited.length - 1].msg.text).toBe("Task added.");
  });

  it.each([
    ["Issue", "/api/projects/p1/issues", "issue:write"],
    ["Risk", "/api/projects/p1/risks", "risk:write"],
  ] as const)("%s goes to its own route and scope", async (kind, path, scope) => {
    const h = fakeDeps();
    const card = await toPreview(h, kind);
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0]).toMatchObject({ path, scopes: [scope] });
  });

  it("asks which project when the person has several", async () => {
    const h = fakeDeps({
      api: async (req) =>
        req.path.startsWith("/api/projects") ? { status: 200, body: { data: [{ id: "p1", name: "Alpha" }, { id: "p2", name: "Beta" }] } } : { status: 201, body: { data: {} } },
    });
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    const pick = h.edited[h.edited.length - 1].msg;
    await tap(h, tapData(pick, "Beta"));
    await say(h, "In beta");
    await tap(h, tapData(last(h), "Confirm"));
    expect(h.writes()[0].path).toBe("/api/projects/p2/tasks");
  });

  it("a double-tapped Confirm writes once: the second tap is silently ignored (compare-and-swap)", async () => {
    const h = fakeDeps();
    const card = await toPreview(h);
    const data = tapData(card, "Confirm");
    await Promise.all([tap(h, data), tap(h, data)]);
    expect(h.writes()).toHaveLength(1);
    // and a late third tap, after the step is done, does nothing either
    await tap(h, data);
    expect(h.writes()).toHaveLength(1);
    expect(h.edited.filter((e) => e.msg.text === "Task added.")).toHaveLength(1);
  });

  it("Cancel button ends the step; a later Confirm on it does nothing", async () => {
    const h = fakeDeps();
    const card = await toPreview(h);
    await tap(h, tapData(card, "Cancel"));
    expect(h.edited[h.edited.length - 1].msg.text).toContain("Cancelled");
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(0);
  });

  it("the word 'cancel' exits a waiting step; with nothing open it says so", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    await say(h, "cancel");
    expect(lastText(h)).toContain("Cancelled");
    await say(h, "Fix the thing");
    expect(lastText(h)).toBe(FREE_TEXT_STUB_REPLY); // the step is gone: this is free text now
    await say(h, "cancel");
    expect(lastText(h)).toBe("Nothing to cancel.");
    expect(h.writes()).toHaveLength(0);
  });

  it("a new command ends a waiting question", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    await say(h, "/1");
    await say(h, "Fix the thing");
    expect(lastText(h)).toBe(FREE_TEXT_STUB_REPLY);
  });

  it("an ask that waited more than 2 minutes expires lazily on the next message", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    h.clock.t += ASK_TTL_MS + 1000;
    await say(h, "Too late");
    expect(lastText(h)).toContain("expired");
    expect(h.writes()).toHaveLength(0);
  });

  it("a preview older than 10 minutes cannot be confirmed", async () => {
    const h = fakeDeps();
    const card = await toPreview(h);
    h.clock.t += STEP_TTL_MS + 1000;
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(0);
    expect(h.edited[h.edited.length - 1].msg.text).toContain("expired");
  });

  it("a viewer who forges the confirm callback is refused", async () => {
    const h = fakeDeps({ identity: profile({ role: "member" }) });
    const card = await toPreview(h);
    (h.deps.lookupIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(profile({ role: "viewer" }));
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(0);
    expect(h.edited[h.edited.length - 1].msg.text).toContain("do not have access");
  });

  it("someone else's pending row is ignored", async () => {
    const h = fakeDeps();
    const card = await toPreview(h);
    (h.deps.lookupIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(profile({ profileId: OTHER_PROFILE_ID }));
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(0);
  });

  it("a switched-off module fails the pending write and says so; the row is not left open", async () => {
    const h = fakeDeps();
    const card = await toPreview(h, "Risk");
    (h.deps.scopeEnabled as ReturnType<typeof vi.fn>).mockImplementation((s: string) => s !== "risk:write");
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(0);
    expect(h.edited[h.edited.length - 1].msg.text).toContain("turned off");
    expect([...h.rows.values()].filter((r) => r.kind === "preview")[0].status).toBe("failed");
  });

  it("a revoked token at confirm fails the write, tells the person and marks the row failed", async () => {
    const h = fakeDeps({ api: async (req) => (req.method === "GET" ? { status: 200, body: { data: [{ id: "p1", name: "Alpha" }] } } : { status: 401, body: { error: "revoked" } }) });
    const card = await toPreview(h);
    await tap(h, tapData(card, "Confirm"));
    expect(h.edited[h.edited.length - 1].msg.text).toContain("no longer valid");
    expect([...h.rows.values()].filter((r) => r.kind === "preview")[0].status).toBe("failed");
  });

  it("an audit failure surfaces as a failed action (the route returns 5xx), never as success", async () => {
    const h = fakeDeps({ api: async (req) => (req.method === "GET" ? { status: 200, body: { data: [{ id: "p1", name: "Alpha" }] } } : { status: 500, body: { error: "audit" } }) });
    const card = await toPreview(h);
    await tap(h, tapData(card, "Confirm"));
    expect(h.edited[h.edited.length - 1].msg.text).not.toBe("Task added.");
    expect(h.edited[h.edited.length - 1].msg.text).toContain("Something went wrong");
  });

  it("over-long text is refused before any preview", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    await say(h, "x".repeat(300));
    expect(lastText(h)).toContain("up to 255");
  });
});

describe("/3 Update task", () => {
  async function toPick(h: ReturnType<typeof fakeDeps>) {
    await say(h, "/3");
    expect(lastText(h)).toContain("few words");
    await say(h, "plan");
    return last(h);
  }

  it("search, pick, set status, confirm: exactly one PATCH with task:write", async () => {
    const h = fakeDeps();
    const list = await toPick(h);
    await tap(h, tapData(list, "Write plan"));
    const actions = h.edited[h.edited.length - 1].msg;
    await tap(h, tapData(actions, "Set to Done"));
    const card = h.edited[h.edited.length - 1].msg;
    expect(card.text).toContain("Set task Write plan to Done");
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toEqual([expect.objectContaining({ method: "PATCH", path: "/api/tasks/t1", scopes: ["task:write"], body: { status_type: "completed" } })]);
  });

  it("deleting is a request only: DELETE with the request scope, never an approve scope", async () => {
    const h = fakeDeps();
    const list = await toPick(h);
    await tap(h, tapData(list, "Write plan"));
    await tap(h, tapData(h.edited[h.edited.length - 1].msg, "Request deletion"));
    const card = h.edited[h.edited.length - 1].msg;
    expect(card.text).toContain("Another approver must approve");
    await tap(h, tapData(card, "Confirm"));
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0]).toMatchObject({ method: "DELETE", scopes: ["task:delete:request"] });
    expect(h.apiCalls.flatMap((c) => c.scopes).some((s) => s.includes("approve"))).toBe(false);
  });

  it("/3 with words skips the question; no match says so", async () => {
    const h = fakeDeps({ api: async () => ({ status: 200, body: { data: [] } }) });
    await say(h, "/3 nothing");
    expect(lastText(h)).toContain("No matching task");
  });

  it("a viewer has no access", async () => {
    const h = fakeDeps({ identity: profile({ role: "viewer" }) });
    await say(h, "/3");
    expect(lastText(h)).toContain("do not have access");
  });

  it("a task the person cannot update (403 from the route) is explained, not hidden", async () => {
    const h = fakeDeps({ api: async (req) => (req.method === "PATCH" ? { status: 403, body: { error: "Locked project" } } : { status: 200, body: { data: [{ id: "t1", name: "Write plan" }] } }) });
    const list = await toPick(h);
    await tap(h, tapData(list, "Write plan"));
    await tap(h, tapData(h.edited[h.edited.length - 1].msg, "Set to Done"));
    await tap(h, tapData(h.edited[h.edited.length - 1].msg, "Confirm"));
    expect(h.edited[h.edited.length - 1].msg.text).toBe("Locked project");
  });
});

describe("/4 Approvals", () => {
  it("members have nothing to decide", async () => {
    const h = fakeDeps();
    await say(h, "/4");
    expect(lastText(h)).toContain("Nothing to decide");
    expect(h.apiCalls).toHaveLength(0);
  });

  it("an approver sees one card per waiting request with Approve and Reject", async () => {
    const h = fakeDeps({ identity: profile({ role: "manager" }) });
    await say(h, "/4");
    expect(lastText(h)).toContain("Delete task");
    expect(tapData(last(h), "Approve")).toMatch(/^ap:/);
    expect(tapData(last(h), "Reject")).toMatch(/^rj:/);
  });

  it("approve: one POST carrying only the matching approve scope, then the row is done", async () => {
    const h = fakeDeps({ identity: profile({ role: "manager" }) });
    await say(h, "/4");
    const data = tapData(last(h), "Approve");
    await Promise.all([tap(h, data), tap(h, data)]);
    expect(h.writes()).toHaveLength(1);
    expect(h.writes()[0]).toMatchObject({ method: "POST", path: "/api/deletion-requests/d1/approve", scopes: ["task:delete:approve"] });
    expect(h.edited[h.edited.length - 1].msg.text).toBe("Approved. Recorded in NoPM.");
  });

  it("reject posts to reject", async () => {
    const h = fakeDeps({ identity: profile({ role: "admin" }) });
    await say(h, "/4");
    await tap(h, tapData(last(h), "Reject"));
    expect(h.writes()[0].path).toBe("/api/deletion-requests/d1/reject");
    expect(h.edited[h.edited.length - 1].msg.text).toBe("Rejected. Recorded in NoPM.");
  });

  it("SELF-APPROVAL refused: the requester gets a card with no buttons, and a forged tap changes nothing", async () => {
    const own = async (req: { method: string; path: string }) =>
      req.method === "GET" ? { status: 200, body: { data: [{ id: "d1", target_type: "task", requested_by_label: "Pat", requested_principal_id: PROFILE_ID }] } } : { status: 200, body: {} };
    const h = fakeDeps({ identity: profile({ role: "manager" }), api: own });
    await say(h, "/4");
    expect(last(h)?.keyboard).toBeUndefined();
    expect(lastText(h)).toContain("You raised this request");
    // someone forges the buttons for that row
    const row = [...h.rows.values()].find((r) => r.kind === "approval")!;
    for (const verb of ["ap", "rj"]) await tap(h, `${verb}:${row.id}`);
    expect(h.writes()).toHaveLength(0);
    expect(h.answers.some((a) => a.text?.includes("stays pending"))).toBe(true);
    expect([...h.rows.values()].find((r) => r.kind === "approval")!.status).toBe("open"); // request stays pending
  });

  it("a server-side refusal (the route repeats four-eyes) is shown and leaves nothing decided", async () => {
    const h = fakeDeps({
      identity: profile({ role: "manager" }),
      api: async (req) => (req.method === "GET" ? { status: 200, body: { data: [{ id: "d1", target_type: "task", requested_principal_id: OTHER_PROFILE_ID }] } } : { status: 403, body: { error: "You cannot approve your own request" } }),
    });
    await say(h, "/4");
    await tap(h, tapData(last(h), "Approve"));
    expect(h.edited[h.edited.length - 1].msg.text).toBe("You cannot approve your own request");
  });

  it("a module that is switched off cannot be decided from chat", async () => {
    const h = fakeDeps({ identity: profile({ role: "manager" }) });
    await say(h, "/4");
    (h.deps.scopeEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await tap(h, tapData(last(h), "Approve"));
    expect(h.writes()).toHaveLength(0);
  });

  it("a member who forges an approve tap is refused", async () => {
    const h = fakeDeps({ identity: profile({ role: "manager" }) });
    await say(h, "/4");
    const data = tapData(last(h), "Approve");
    (h.deps.lookupIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(profile({ role: "member" }));
    await tap(h, data);
    expect(h.writes()).toHaveLength(0);
  });
});

describe("free text", () => {
  it("goes to the assistant seam; the stub points at Settings and never touches NoPM", async () => {
    const h = fakeDeps();
    await say(h, "how are we doing on Alpha?");
    expect(lastText(h)).toBe("Free-text questions go to your assistant. Add your own model key in Settings.");
    expect(h.apiCalls).toHaveLength(0);
  });

  it("a wired assistant receives the linked actor and its answer is relayed", async () => {
    const askAssistant = vi.fn(async () => ({ text: "All green." }));
    const h = fakeDeps({ askAssistant });
    await say(h, "status please?");
    expect(askAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE_ID, role: "member", workspaceId: fixtureConnector().workspace_id, connectorId: fixtureConnector().id }),
      "status please?",
    );
    expect(lastText(h)).toBe("All green.");
  });

  it("an assistant failure becomes a plain sentence, not an error", async () => {
    const h = fakeDeps({ askAssistant: async () => { throw new Error("boom"); } });
    await say(h, "anything");
    expect(lastText(h)).toContain("Something went wrong");
  });
});

describe("limits", () => {
  it("every callback_data the bot ever offers is 64 bytes or less", async () => {
    const h = fakeDeps({ identity: profile({ role: "admin" }) });
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    await say(h, "One line");
    await tap(h, tapData(last(h), "Cancel"));
    await say(h, "/3 plan");
    await tap(h, tapData(last(h), "Write plan"));
    await say(h, "/4");
    const data = allCallbackData(h).filter(Boolean);
    expect(data.length).toBeGreaterThan(8);
    for (const d of data) expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
  });

  it("each completed write is exactly one REST call (so exactly one audit row)", async () => {
    const h = fakeDeps();
    await say(h, "/2");
    await tap(h, tapData(last(h), "Task"));
    await say(h, "One");
    const confirm = tapData(last(h), "Confirm");
    await tap(h, confirm);
    await tap(h, confirm);
    expect(h.writes()).toHaveLength(1);
  });
});
