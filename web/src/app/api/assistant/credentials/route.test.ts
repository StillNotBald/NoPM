import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const { requireAuthMock, writeAuditMock, upsertMock, mutateMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  writeAuditMock: vi.fn(async () => {}),
  upsertMock: vi.fn(),
  mutateMock: vi.fn(),
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s }));
vi.mock("@/lib/auth/demo", () => ({ isDemoActor: async () => false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      // Atomic write + audit (migration 0103).
      if (fn === "nopm_mutate_audited") {
        mutateMock(args);
        return { data: { before: null, after: { id: "c1", ...(args.p_patch as object) } }, error: null };
      }
      return { data: { allowed: true, remaining: 999, retry_after_seconds: 0 }, error: null };
    },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
      upsert: (row: Record<string, unknown>) => {
        upsertMock(row);
        return { select: () => ({ single: async () => ({ data: { id: "c1", provider: row.provider, model: row.model }, error: null }) }) };
      },
    }),
  }),
}));

import { PUT } from "./route";

const actor: Actor = { type: "user", id: "u1", label: "Pat", workspaceId: "w1", role: "member", principalId: "u1" };
const put = (body: Record<string, unknown>) =>
  PUT(
    new NextRequest("http://localhost:3000/api/assistant/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor);
  writeAuditMock.mockClear();
  upsertMock.mockReset();
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("PUT /api/assistant/credentials (Q-ACC-12)", () => {
  it("refuses an unknown provider (422) and stores nothing", async () => {
    const res = await put({ provider: "acme-llm", apiKey: "k", model: "m" });
    expect(res.status).toBe(422);
    expect((await res.json()).code ?? "").toBe("unknown_provider");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("tests the key first; a rejected key is refused with the friendly message and nothing is stored", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const res = await put({ provider: "openai", apiKey: "sk-bad", model: "gpt-4o-mini" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("That key did not work with this provider. Check it and try again.");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("a provider outage is not a verdict on the key: refused with a retry message, nothing stored", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const res = await put({ provider: "anthropic", apiKey: "k", model: "m" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("key_unverified");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("a working key is saved encrypted with one audit row, and is never put in a URL", async () => {
    const res = await put({ provider: "google", apiKey: "g-key-123", model: "gemini" });
    expect(res.status).toBe(200);
    // One atomic write+audit call; the ciphertext is written but kept out of the audit row.
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const args = mutateMock.mock.calls[0][0] as { p_table: string; p_patch: Record<string, unknown>; p_audit: Record<string, unknown> };
    expect(args.p_table).toBe("assistant_credentials");
    expect(args.p_patch).toMatchObject({ provider: "google", api_key_enc: "enc:g-key-123" });
    expect(args.p_audit).toMatchObject({ action: "assistant.credential.set", before: null, after: { provider: "google", model: "gemini" }, omit_columns: ["api_key_enc"] });
    expect(JSON.stringify(args.p_audit)).not.toContain("g-key-123");
    expect(upsertMock).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("g-key-123");
  });
});
