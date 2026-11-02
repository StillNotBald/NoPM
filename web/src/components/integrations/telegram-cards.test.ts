/**
 * Telegram cards: pure model helpers and server-render states (this repo's
 * vitest is node-only, so components render to static markup like
 * render-smoke.test.ts). Effects do not run, so data-driven states are driven
 * through props.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { identitiesFor, normalizeIdentities } from "./model";
import { TelegramAccountCard } from "./telegram-account-card";
import { TelegramConnectorCard } from "./telegram-connector-card";
import {
  normalizeTelegramConnector,
  normalizeTelegramCreated,
  normalizeTelegramLinkCode,
  normalizeTelegramStatus,
  startMessage,
  validateBotToken,
} from "./telegram-model";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

const adminState = (over: Record<string, unknown> = {}) =>
  normalizeTelegramConnector({
    connector: { id: "c1", name: "Telegram", status: "active", bot_username: "example_bot", ...over },
    can_manage: true,
  });

describe("model", () => {
  it("reads the connector view tolerantly and never carries a token", () => {
    const s = normalizeTelegramConnector({ connector: { id: "c1", name: "T", status: "paused", bot_username: "b", token: "123456:SECRETSECRET" }, can_manage: true });
    expect(s).toEqual({ connector: { id: "c1", name: "T", status: "paused", botUsername: "b" }, canManage: true });
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(normalizeTelegramConnector(null)).toEqual({ connector: null, canManage: false });
  });

  it("reads the create result including a failed registration step", () => {
    const r = normalizeTelegramCreated({ id: "c1", name: "T", status: "active", registration: { ok: false, step: "webhook", error: "bad" } });
    expect(r.registration).toEqual({ ok: false, step: "webhook", error: "bad" });
    expect(normalizeTelegramCreated({ id: "c1", registration: { ok: true } }).registration).toEqual({ ok: true });
  });

  it("reads webhook status, defaulting to error on anything unexpected", () => {
    expect(normalizeTelegramStatus({ webhook: "ok", pending_updates: 2, last_update_at: "2026-11-03T00:00:00Z" })).toMatchObject({ webhook: "ok", pendingUpdates: 2 });
    expect(normalizeTelegramStatus({}).webhook).toBe("error");
  });

  it("accepts only a t.me deep link and keeps the expiry the server gave", () => {
    const ok = normalizeTelegramLinkCode({ code: "NPL-ABCD-2345", expires_at: "2026-11-03T00:10:00.000Z", deep_link: "https://t.me/example_bot?start=NPL-ABCD-2345" }, 0);
    expect(ok).toMatchObject({ code: "NPL-ABCD-2345", expiresAt: Date.parse("2026-11-03T00:10:00.000Z"), deepLink: "https://t.me/example_bot?start=NPL-ABCD-2345" });
    expect(normalizeTelegramLinkCode({ code: "X", deep_link: "https://evil.example/x" }, 0)?.deepLink).toBeNull();
    expect(normalizeTelegramLinkCode({}, 0)).toBeNull();
    expect(startMessage(" NPL-ABCD-2345 ")).toBe("/start NPL-ABCD-2345");
  });

  it("validates the BotFather token shape", () => {
    expect(validateBotToken("")).toMatch(/Paste/);
    expect(validateBotToken("nope")).toMatch(/does not look/);
    expect(validateBotToken("123456789:AAHexample_token-1234")).toBeNull();
  });

  it("splits one identity list by chat platform; a row with no provider counts as Lark", () => {
    const list = normalizeIdentities([
      { id: "a", provider: "lark", profile_id: "me" },
      { id: "b", provider: "telegram", profile_id: "me" },
      { id: "c", profile_id: "me" },
    ]);
    expect(identitiesFor(list, "telegram").map((i) => i.id)).toEqual(["b"]);
    expect(identitiesFor(list, "lark").map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("TelegramConnectorCard", () => {
  const render = (isAdmin: boolean | null, resource: Parameters<typeof TelegramConnectorCard>[0]["resource"]) =>
    html(createElement(TelegramConnectorCard, { isAdmin, resource, onRetry: noop, onChanged: noop }));

  it("loading: a polite status row, no controls", () => {
    const markup = render(null, { status: "loading" });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading the Telegram connection");
    expect(markup).not.toContain("<button");
  });

  it("empty (admin): BotFather help text and a write-only password field with a wired label", () => {
    const markup = render(true, { status: "ready", data: { connector: null, canManage: true } });
    for (const t of ["How to create a bot", "@BotFather", "/newbot", "Connect Telegram", "Bot token"]) expect(markup).toContain(t);
    expect(markup).toMatch(/id="telegram-token"[^>]*type="password"|type="password"[^>]*id="telegram-token"/);
    expect(markup).toContain('for="telegram-token"');
    expect(markup).toContain('autoComplete="new-password"');
  });

  it("empty (member): calm read-only line, no form", () => {
    const markup = render(false, { status: "ready", data: { connector: null, canManage: false } });
    expect(markup).toContain("A workspace admin can connect it here");
    expect(markup).not.toContain("<input");
  });

  it("error: the message and a retry", () => {
    const markup = render(true, { status: "error", message: "boom" });
    expect(markup).toContain("boom");
    expect(markup).toContain("Try again");
    expect(markup).toContain('role="alert"');
  });

  it("forbidden and unavailable are calm copy, not alerts", () => {
    expect(render(false, { status: "forbidden", message: "x" })).not.toContain('role="alert"');
    expect(render(true, { status: "unavailable", message: "x" })).toContain("not available here yet");
  });

  it("connected (admin): the bot, the actions, and no token anywhere", () => {
    const markup = render(true, { status: "ready", data: adminState() });
    for (const t of ["@example_bot", "Send test to me", "Reconnect", "Disable", "Disconnect"]) expect(markup).toContain(t);
    expect(markup).not.toContain('type="password"');
  });

  it("disabled: says so and offers Enable", () => {
    const markup = render(true, { status: "ready", data: adminState({ status: "paused" }) });
    expect(markup).toContain("Enable");
    expect(markup).toContain("turned off");
  });

  it("connected (member): status line only, no admin controls", () => {
    const markup = render(false, { status: "ready", data: normalizeTelegramConnector({ connector: { name: "Telegram", status: "active" }, can_manage: false }) });
    expect(markup).toContain("Telegram is connected.");
    expect(markup).not.toContain("Disconnect");
  });
});

describe("TelegramAccountCard", () => {
  const account = (identities: Parameters<typeof TelegramAccountCard>[0]["identities"], over: Partial<Parameters<typeof TelegramAccountCard>[0]> = {}) =>
    html(
      createElement(TelegramAccountCard, {
        isAdmin: false,
        myProfileId: "me",
        connector: adminState().connector,
        connectorKnown: true,
        identities,
        onRetry: noop,
        onReload: noop,
        ...over,
      }),
    );

  it("loading and error states", () => {
    expect(account({ status: "loading" })).toContain("Checking your Telegram link");
    const err = account({ status: "error", message: "nope" });
    expect(err).toContain("nope");
    expect(err).toContain("Try again");
  });

  it("not linked: explains the 10 minute code and offers Link Telegram", () => {
    const markup = account({ status: "ready", data: [] });
    expect(markup).toContain("Link Telegram");
    expect(markup).toContain("10 minutes");
    expect(markup).toContain('aria-live="polite"');
  });

  it("linked: shows the username, the badge and Unlink", () => {
    const data = identitiesFor(normalizeIdentities([{ id: "i1", provider: "telegram", profile_id: "me", display_name: "@pat_example", linked_at: "2026-10-10T00:00:00Z" }]), "telegram");
    const markup = account({ status: "ready", data });
    expect(markup).toContain("@pat_example");
    expect(markup).toContain("linked");
    expect(markup).toContain("Unlink");
    expect(markup).toContain("unlink this one first");
  });

  it("no bot or a disabled bot: names the prerequisite and has no link button", () => {
    const none = account({ status: "ready", data: [] }, { connector: null });
    expect(none).toContain("once an admin has connected Telegram");
    expect(none).not.toContain("Link Telegram");
    const off = account({ status: "ready", data: [] }, { connector: adminState({ status: "paused" }).connector, isAdmin: true });
    expect(off).toContain("Enable it above");
  });
});
