import { describe, it, expect } from "vitest";
import { resolveClientMeta, resolveRequestId } from "./channel";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("resolveClientMeta — channel", () => {
  it("honors X-NoPM-Client when it names a known channel", () => {
    for (const channel of ["ui", "api", "cli", "mcp", "assistant"] as const) {
      expect(resolveClientMeta(headers({ "x-nopm-client": channel }), "user").channel).toBe(channel);
      expect(resolveClientMeta(headers({ "x-nopm-client": channel }), "token").channel).toBe(channel);
    }
  });

  it("is case-sensitive — an uppercase or mixed-case value is not a match", () => {
    expect(resolveClientMeta(headers({ "x-nopm-client": "CLI" }), "token").channel).toBe("api");
    expect(resolveClientMeta(headers({ "x-nopm-client": "Cli" }), "token").channel).toBe("api");
  });

  it("defaults to 'ui' for a session (user) actor when the header is absent", () => {
    expect(resolveClientMeta(headers({}), "user").channel).toBe("ui");
  });

  it("defaults to 'api' for a token actor when the header is absent", () => {
    expect(resolveClientMeta(headers({}), "token").channel).toBe("api");
  });

  it("falls back to the actor-type default on an unrecognized value", () => {
    expect(resolveClientMeta(headers({ "x-nopm-client": "webhook" }), "user").channel).toBe("ui");
    expect(resolveClientMeta(headers({ "x-nopm-client": "webhook" }), "token").channel).toBe("api");
  });

  it("falls back to the actor-type default on an empty string value", () => {
    expect(resolveClientMeta(headers({ "x-nopm-client": "" }), "user").channel).toBe("ui");
  });
});

describe("resolveClientMeta — requestId", () => {
  it("echoes a valid incoming X-Request-Id", () => {
    expect(resolveClientMeta(headers({ "x-request-id": "abc-123.DEF_456" }), "user").requestId).toBe(
      "abc-123.DEF_456",
    );
  });

  it("accepts the maximum length (64 chars)", () => {
    const id = "a".repeat(64);
    expect(resolveClientMeta(headers({ "x-request-id": id }), "user").requestId).toBe(id);
  });

  it("generates a fresh id when the header is absent", () => {
    const { requestId } = resolveClientMeta(headers({}), "user");
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a fresh id when the incoming value is too long (65 chars)", () => {
    const tooLong = "a".repeat(65);
    const { requestId } = resolveClientMeta(headers({ "x-request-id": tooLong }), "user");
    expect(requestId).not.toBe(tooLong);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a fresh id when the incoming value is empty", () => {
    const { requestId } = resolveClientMeta(headers({ "x-request-id": "" }), "user");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a fresh id when the incoming value has disallowed characters", () => {
    const { requestId } = resolveClientMeta(headers({ "x-request-id": "has a space" }), "user");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const { requestId: requestId2 } = resolveClientMeta(
      headers({ "x-request-id": "has/slash" }),
      "user",
    );
    expect(requestId2).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two calls with no header generate two different ids", () => {
    const a = resolveClientMeta(headers({}), "user").requestId;
    const b = resolveClientMeta(headers({}), "user").requestId;
    expect(a).not.toBe(b);
  });
});

describe("resolveRequestId — shared by route() and the MCP HTTP endpoint", () => {
  it("returns the incoming X-Request-Id when it is a safe token", () => {
    expect(resolveRequestId(headers({ "x-request-id": "req_ABC-123.9" }))).toBe("req_ABC-123.9");
  });
  it("generates a UUID when the header is missing or unsafe", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(resolveRequestId(headers({}))).toMatch(uuid);
    expect(resolveRequestId(headers({ "x-request-id": "bad id with spaces" }))).toMatch(uuid);
    expect(resolveRequestId(headers({ "x-request-id": "x".repeat(65) }))).toMatch(uuid);
  });
  it("agrees with resolveClientMeta for the same headers", () => {
    const h = headers({ "x-request-id": "same-id" });
    expect(resolveClientMeta(h, "token").requestId).toBe(resolveRequestId(h));
  });
});
