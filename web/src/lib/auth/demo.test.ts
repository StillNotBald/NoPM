/**
 * isDemoActor decision-logic tests.
 *
 * Core invariants:
 *  - token actors are NEVER the demo account (short-circuits without a DB call)
 *  - DEMO_EMAIL unset → always false (short-circuits without a DB call)
 *  - session actor whose profile email matches DEMO_EMAIL → true
 *  - session actor whose profile email differs → false
 *  - DB error / no profile found → fail closed (false) — never mistakenly
 *    treat a real user as the demo account.
 *
 * No live DB — @/lib/supabase/admin is mocked throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "./guard";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

import { isDemoActor } from "./demo";

function userActor(id = "usr_1"): Actor {
  return { type: "user", id, label: "Some User", workspaceId: "ws_1" };
}

function tokenActor(): Actor {
  return { type: "token", id: "tok_1", label: "ci-agent", workspaceId: "ws_1", scopes: ["project:read"] };
}

function fakeDbReturning(result: { data: { email: string } | null; error: { message: string } | null }) {
  const maybeSingle = vi.fn(async () => result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from };
}

const ORIGINAL_DEMO_EMAIL = process.env.DEMO_EMAIL;

beforeEach(() => {
  createAdminClient.mockReset();
});

afterEach(() => {
  if (ORIGINAL_DEMO_EMAIL === undefined) delete process.env.DEMO_EMAIL;
  else process.env.DEMO_EMAIL = ORIGINAL_DEMO_EMAIL;
});

describe("isDemoActor — token actors", () => {
  it("is always false for a token actor, without touching the database", async () => {
    process.env.DEMO_EMAIL = "demo@stillnotbald.com";
    await expect(isDemoActor(tokenActor())).resolves.toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("isDemoActor — DEMO_EMAIL not configured", () => {
  it("is always false when DEMO_EMAIL is unset, without touching the database", async () => {
    delete process.env.DEMO_EMAIL;
    await expect(isDemoActor(userActor())).resolves.toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});

describe("isDemoActor — session actors, DEMO_EMAIL configured", () => {
  beforeEach(() => {
    process.env.DEMO_EMAIL = "demo@stillnotbald.com";
  });

  it("is true when the actor's profile email matches DEMO_EMAIL", async () => {
    createAdminClient.mockReturnValue(fakeDbReturning({ data: { email: "demo@stillnotbald.com" }, error: null }));
    await expect(isDemoActor(userActor())).resolves.toBe(true);
  });

  it("is false when the actor's profile email differs from DEMO_EMAIL (e.g. a display_name-bearing real user)", async () => {
    createAdminClient.mockReturnValue(fakeDbReturning({ data: { email: "alice@example.com" }, error: null }));
    await expect(isDemoActor(userActor())).resolves.toBe(false);
  });

  it("R-13: fails closed (throws) when the profile lookup errors, so a DB hiccup cannot pass the demo account through", async () => {
    createAdminClient.mockReturnValue(
      fakeDbReturning({ data: null, error: { message: "connection reset" } }),
    );
    await expect(isDemoActor(userActor())).rejects.toBeTruthy();
  });

  it("is false (not the demo account) when no profile is found for the actor id", async () => {
    createAdminClient.mockReturnValue(fakeDbReturning({ data: null, error: null }));
    await expect(isDemoActor(userActor())).resolves.toBe(false);
  });

  it("looks the profile up by the actor's id (not by label)", async () => {
    const db = fakeDbReturning({ data: { email: "demo@stillnotbald.com" }, error: null });
    createAdminClient.mockReturnValue(db);

    await isDemoActor(userActor("usr_specific_id"));

    expect(db.from).toHaveBeenCalledWith("profiles");
    const selectResult = db.from.mock.results[0].value as { select: ReturnType<typeof vi.fn> };
    const eqResult = selectResult.select.mock.results[0].value as { eq: ReturnType<typeof vi.fn> };
    expect(eqResult.eq).toHaveBeenCalledWith("id", "usr_specific_id");
  });
});
