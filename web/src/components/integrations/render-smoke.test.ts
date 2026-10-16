/**
 * Server-render smoke tests for the Integrations console.
 *
 * There is no DOM test environment in this repo (vitest is node-only), so
 * these render each component to static markup with `react-dom/server`. That
 * catches what a type-check cannot — a render-time throw, a missing context
 * default, a label that is not wired to its control — and pins the structure
 * a keyboard/screen-reader user depends on. Effects do not run in a server
 * render, so data-driven cards are exercised through their prop states.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalendarFeedsCard } from "./calendar-feeds-card";
import { ConnectForm } from "./connect-form";
import { ConnectedPanel } from "./connected-panel";
import { FeatureFields } from "./feature-fields";
import { GovernanceNote } from "./governance-note";
import { IntegrationsConsole } from "./integrations-console";
import { LarkAccountCard } from "./lark-account-card";
import { LarkConnectorCard } from "./lark-connector-card";
import { normalizeConnector, normalizeIdentities, type ConnectorView } from "./model";
import { CopyValue, RadioCards } from "./shared";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop = () => {};

function connector(overrides: Record<string, unknown> = {}): ConnectorView {
  const c = normalizeConnector({
    id: "c1",
    name: "Team Lark",
    status: "active",
    region: "lark",
    mode: "webhook",
    app_id: "cli_abc",
    approvals: { enabled: true },
    digest: { enabled: true, chat_id: "oc_abcdef123456", weekday: 1 },
    has_encrypt_key: false,
    secrets_readable: true,
    ...overrides,
  });
  if (!c) throw new Error("fixture connector did not normalise");
  return c;
}

/** Every <label for="x"> must point at an element with id="x". */
function labelsAreWired(markup: string): string[] {
  const missing: string[] = [];
  for (const m of markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) {
    if (!markup.includes(`id="${m[1]}"`)) missing.push(m[1]);
  }
  return missing;
}

describe("ConnectForm", () => {
  const markup = html(createElement(ConnectForm, { onCreated: noop, onCancel: noop }));

  it("labels every credential field and wires each label to its control", () => {
    for (const label of ["Name", "App ID", "App Secret", "Verification Token", "Encrypt Key"]) {
      expect(markup).toContain(label);
    }
    expect(labelsAreWired(markup)).toEqual([]);
  });

  it("masks secrets by default and marks the optional one", () => {
    expect(markup).toMatch(/id="lark-app-secret"[^>]*type="password"|type="password"[^>]*id="lark-app-secret"/);
    expect(markup).toContain("(optional)");
  });

  it("offers region and mode as radio groups with legends", () => {
    expect(markup).toContain("<legend");
    expect(markup).toContain("Lark (international)");
    expect(markup).toContain("Feishu (China)");
    expect(markup).toContain("Webhook");
    expect(markup).toContain("Long connection");
    expect(markup.match(/type="radio"/g)?.length).toBe(4);
  });

  it("hides the digest details until the digest is switched on", () => {
    expect(markup).not.toContain("Group chat ID");
    expect(markup).toContain("Approve from chat");
    expect(markup).toContain("Weekly digest");
  });
});

describe("FeatureFields", () => {
  it("reveals the chat id + weekday when the digest is on, with the error announced", () => {
    const markup = html(
      createElement(FeatureFields, {
        values: { approvalsEnabled: true, digestEnabled: true, digestChatId: "", digestWeekday: 1 },
        onChange: noop,
        errors: { digestChatId: "Enter the group chat ID the digest should be posted to." },
        idPrefix: "t",
      }),
    );
    expect(markup).toContain("Group chat ID");
    expect(markup).toContain("Weekday (UTC)");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toMatch(/role="alert"[^>]*>Enter the group chat ID/);
    expect(labelsAreWired(markup)).toEqual([]);
  });
});

describe("shared blocks", () => {
  it("CopyValue exposes a polite live region and a named copy button", () => {
    const markup = html(createElement(CopyValue, { label: "Event request URL", value: "https://x.example/e", subject: "event request URL" }));
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-label="Copy event request URL"');
    expect(markup).toContain("https://x.example/e");
  });

  it("RadioCards render one fieldset per group with a checked option", () => {
    const markup = html(
      createElement(RadioCards<"a" | "b">, {
        legend: "Pick one",
        name: "pick",
        value: "b",
        onChange: noop,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }),
    );
    expect(markup).toContain("<fieldset");
    expect(markup.match(/checked=""/g)?.length).toBe(1);
  });
});

describe("ConnectedPanel", () => {
  const render = (c: ConnectorView, linkedTotal: number | null = 3) =>
    html(createElement(ConnectedPanel, { connector: c, serverUrls: null, linkedTotal, onChanged: noop }));

  it("shows the facts and the five admin actions", () => {
    const markup = render(connector());
    for (const text of [
      "Team Lark",
      "Lark (international)",
      "Webhook",
      "cli_abc",
      "3 members linked",
      "Test connection",
      "Send digest now",
      "Pause",
      "Edit settings",
      "Revoke",
      "Lark developer console setup",
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("shows the server-built callback URLs for a webhook connector, not an address guessed in the browser", () => {
    const serverEvents = "https://configured.example.com/api/integrations/lark/c1/events";
    const serverCard = "https://configured.example.com/api/integrations/lark/c1/card";
    const markup = render(
      connector({ callback_urls: { events: serverEvents, card: serverCard, relay: "https://configured.example.com/r" } }),
    );
    expect(markup).toContain(serverEvents);
    expect(markup).toContain(serverCard);
    // Server render has no browser address, so there is nothing to disagree with.
    expect(markup).not.toContain("differs from the address");
  });

  it("falls back to remembered create-time URLs when the list read omits them", () => {
    const remembered = {
      events: "https://remembered.example.com/api/integrations/lark/c1/events",
      card: "https://remembered.example.com/api/integrations/lark/c1/card",
      relay: null,
    };
    const markup = html(
      createElement(ConnectedPanel, { connector: connector(), serverUrls: remembered, linkedTotal: 0, onChanged: noop }),
    );
    expect(markup).toContain(remembered.events);
  });

  it("never prints secret material (there is none in the view model)", () => {
    const markup = render(connector({ has_encrypt_key: true }));
    expect(markup).not.toMatch(/app_secret|verification_token|relay_secret/);
    expect(markup).toContain("Signed and encrypted");
  });

  it("offers Resume (and says so) when paused, and disables the digest", () => {
    const markup = render(connector({ status: "paused" }));
    expect(markup).toContain("Resume");
    expect(markup).toContain("Nothing is sent to Lark and chat buttons are ignored until you resume");
    expect(markup).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Send digest now/);
  });

  it("explains why the digest is off instead of leaving a dead button", () => {
    const markup = render(connector({ digest: { enabled: false, chat_id: null, weekday: 1 } }));
    expect(markup).toContain("To send a digest, turn on the weekly digest");
  });

  it("warns when the server can no longer decrypt the stored credentials", () => {
    expect(render(connector({ secrets_readable: false }))).toContain("can no longer decrypt");
  });

  it("renders delivery health only when the API returned it", () => {
    expect(render(connector())).not.toContain("Healthy");
    const withHealth = render(connector({ delivery_health: { sent: 5, retry: 0, failed: 0, last_sent_at: "2020-01-01T00:00:00Z" } }));
    expect(withHealth).toContain("Healthy");
    expect(withHealth).toContain("5 sent");
  });
});

describe("LarkConnectorCard", () => {
  const card = (props: Partial<Parameters<typeof LarkConnectorCard>[0]>) =>
    html(
      createElement(LarkConnectorCard, {
        isAdmin: true,
        resource: { status: "ready", data: null },
        linkedTotal: null,
        onRetry: noop,
        onChanged: noop,
        ...props,
      }),
    );

  it("admin with no connector sees the value sentence and a Connect button, not the long form", () => {
    const markup = card({});
    expect(markup).toContain("Connect Lark or Feishu");
    expect(markup).toContain("recorded once in the Trust Center");
    expect(markup).not.toContain("App Secret");
  });

  it("admin with a connector sees the connected panel", () => {
    expect(card({ resource: { status: "ready", data: connector() } })).toContain("Test connection");
  });

  it("non-admin gets a read-only status line with no controls", () => {
    const markup = card({ isAdmin: false, resource: { status: "ready", data: connector() } });
    expect(markup).toContain("Only workspace admins can change this connection.");
    expect(markup).not.toContain("Test connection");
    expect(markup).not.toContain("Revoke");
  });

  it("non-admin sees the one-line status from the redacted view, and none of the admin-only detail", () => {
    // The redacted member view: id, name, kind, status, region, mode, approvals.enabled, digest.enabled.
    const redacted = normalizeConnector({
      id: "c1",
      name: "Team Lark",
      kind: "lark",
      status: "active",
      region: "lark",
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: true },
    })!;
    const markup = card({ isAdmin: false, resource: { status: "ready", data: redacted } });
    expect(markup).toContain("Lark connected · approvals on · digest on");
    expect(markup).toContain("Lark (international) · Webhook");
    expect(markup).not.toContain("App ID");
    expect(markup).not.toContain("Edit settings");
  });

  it("non-admin with no connector is told so, and a paused one is reported as paused", () => {
    expect(card({ isAdmin: false, resource: { status: "ready", data: null } })).toContain("isn&#x27;t connected");
    const paused = card({ isAdmin: false, resource: { status: "ready", data: connector({ status: "paused" }) } });
    expect(paused).toContain("Lark paused · approvals on · digest on");
  });

  it("degrades calmly for 403, 404 and loading, and offers a retry on error", () => {
    expect(card({ resource: { status: "forbidden", message: "no" } })).toContain("Only workspace admins can see or change");
    expect(card({ resource: { status: "unavailable", message: "no" } })).toContain("aren&#x27;t available on this deployment");
    expect(card({ resource: { status: "loading" } })).toContain("Loading the Lark connection");
    expect(card({ isAdmin: null, resource: { status: "ready", data: null } })).toContain("Loading the Lark connection");
    const failed = card({ resource: { status: "error", message: "db down" } });
    expect(failed).toContain("db down");
    expect(failed).toContain("Try again");
  });
});

describe("LarkAccountCard", () => {
  const card = (props: Partial<Parameters<typeof LarkAccountCard>[0]>) =>
    html(
      createElement(LarkAccountCard, {
        isAdmin: false,
        myProfileId: "me",
        connector: connector(),
        connectorKnown: true,
        identities: { status: "ready", data: [] },
        onRetry: noop,
        onReload: noop,
        ...props,
      }),
    );

  it("unlinked member can start linking", () => {
    const markup = card({});
    expect(markup).toContain("Link my Lark account");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Link my Lark account/);
  });

  it("linked member sees who they linked as and can unlink", () => {
    const markup = card({
      identities: {
        status: "ready",
        data: normalizeIdentities([{ id: "i1", profile_id: "me", display_name: "Member One", linked_at: "2026-10-10T00:00:00Z" }]),
      },
    });
    expect(markup).toContain("Member One");
    expect(markup).toContain("Unlink");
    expect(markup).not.toContain("Link my Lark account");
  });

  it("an admin viewing everyone's links only sees their own as linked", () => {
    const markup = card({
      isAdmin: true,
      identities: {
        status: "ready",
        data: normalizeIdentities([{ id: "i9", profile_id: "someone-else", display_name: "Member Two" }]),
      },
    });
    expect(markup).toContain("Link my Lark account");
    expect(markup).not.toContain("Member Two");
  });

  it("blocks linking, with the reason, when no connector is live", () => {
    const none = card({ connector: null, connectorKnown: true });
    expect(none).toContain("Ask a workspace admin to connect it");
    expect(none).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Link my Lark account/);
    expect(card({ connector: null, connectorKnown: true, isAdmin: true })).toContain("Connect it above");
    expect(card({ connector: connector({ status: "paused" }) })).toContain("paused");
  });

  it("does not block when the connector is simply not visible to this member", () => {
    const markup = card({ connector: null, connectorKnown: false });
    expect(markup).not.toContain("Ask a workspace admin");
    expect(markup).toContain("Link my Lark account");
  });
});

describe("CalendarFeedsCard", () => {
  it("lets a member create a feed (name + optional project) and shows the loading state", () => {
    const markup = html(createElement(CalendarFeedsCard, { role: "member" }));
    expect(markup).toContain("Feed name");
    expect(markup).toContain("All projects");
    expect(markup).toContain("Create feed");
    expect(markup).toContain("Loading your feeds");
    expect(labelsAreWired(markup)).toEqual([]);
  });

  it("tells a viewer they cannot create one instead of offering a form that 403s", () => {
    const markup = html(createElement(CalendarFeedsCard, { role: "viewer" }));
    expect(markup).toContain("Viewers can&#x27;t create calendar feeds");
    expect(markup).not.toContain("Create feed");
  });
});

describe("GovernanceNote", () => {
  it("is a collapsed native disclosure naming the three guarantees", () => {
    const markup = html(createElement(GovernanceNote));
    expect(markup).toContain("<details");
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain("How approvals from chat stay governed");
    expect(markup).toContain("A different person decides");
    expect(markup).toContain("single-use");
    expect(markup).toContain("Trust Center");
    expect(markup).toContain("lark");
  });
});

describe("IntegrationsConsole", () => {
  it("renders all four sections from a cold start without throwing", () => {
    const markup = html(createElement(IntegrationsConsole));
    for (const text of ["Lark / Feishu", "Your Lark account", "Calendar feed", "How approvals from chat stay governed"]) {
      expect(markup).toContain(text);
    }
  });
});
