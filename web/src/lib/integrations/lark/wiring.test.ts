import { describe, it, expect, afterEach, vi } from "vitest";
import { claimEventInMemory, productionContext, productionDeps } from "./wiring";
import { fixtureConnector, fixtureSecrets } from "./fixtures";

afterEach(() => vi.unstubAllEnvs());

describe("claimEventInMemory", () => {
  it("lets the first delivery through and drops redeliveries", () => {
    const t = 1_000_000;
    expect(claimEventInMemory("c-dedupe-1", "evt-a", t)).toBe(true);
    expect(claimEventInMemory("c-dedupe-1", "evt-a", t + 1000)).toBe(false);
    expect(claimEventInMemory("c-dedupe-1", "evt-b", t + 1000)).toBe(true);
  });

  it("keys on the connector as well as the event", () => {
    const t = 2_000_000;
    expect(claimEventInMemory("c-dedupe-2", "evt-x", t)).toBe(true);
    expect(claimEventInMemory("c-dedupe-3", "evt-x", t)).toBe(true);
  });

  it("forgets an event after an hour", () => {
    const t = 3_000_000;
    expect(claimEventInMemory("c-dedupe-4", "evt-old", t)).toBe(true);
    expect(claimEventInMemory("c-dedupe-4", "evt-old", t + 60 * 60 * 1000 + 1)).toBe(true);
  });
});

describe("productionContext", () => {
  it("prefers NEXT_PUBLIC_APP_URL over the request origin for deep links", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test/");
    const { ctx } = productionContext(fixtureConnector(), "https://internal.example.test", fixtureSecrets());
    expect(ctx.appUrl).toBe("https://pm.example.test");
  });

  it("falls back to the origin the platform called when the env var is unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const { ctx } = productionContext(fixtureConnector(), "https://called.example.test", fixtureSecrets());
    expect(ctx.appUrl).toBe("https://called.example.test");
  });

  it("uses the supplied secrets without decrypting again, and can run background work outside a request", async () => {
    const secrets = fixtureSecrets();
    const { ctx, deps } = productionContext(fixtureConnector(), null, secrets);
    expect(ctx.secrets).toBe(secrets);
    expect(() => ctx.background?.(Promise.resolve())).not.toThrow();
    expect(typeof deps.handleApprovalAction).toBe("function");
    expect(typeof deps.consumeLinkCode).toBe("function");
  });

  it("wires the real hub functions and the in-memory claim", async () => {
    const deps = productionDeps();
    expect(await deps.claimEvent("c-wiring", "evt-wiring-1")).toBe(true);
    expect(await deps.claimEvent("c-wiring", "evt-wiring-1")).toBe(false);
    expect(deps.now()).toBeInstanceOf(Date);
  });
});
