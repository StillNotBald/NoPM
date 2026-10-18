import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const { requireAuthMock, listMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn(), listMock: vi.fn() }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/review/pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review/pending")>()),
  listPendingApprovals: (...args: unknown[]) => listMock(...args),
}));

import { GET } from "./route";

const call = (qs = "") => GET(new NextRequest(`http://localhost/api/review${qs}`), { params: Promise.resolve({}) });

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({
    type: "user", id: "u1", label: "u", workspaceId: "ws-1", role: "manager", principalId: "u1",
  } satisfies Actor);
  listMock.mockReset();
  listMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 50, hidden_kinds: [] });
});

describe("GET /api/review?mine", () => {
  it.each([["?mine=1", true], ["?mine=true", true], ["", false], ["?mine=0", false], ["?mine=yes", false]])(
    "%s -> mine %s",
    async (qs, expected) => {
      expect((await call(qs)).status).toBe(200);
      expect(listMock.mock.calls[0][3]).toMatchObject({ mine: expected });
    },
  );
});
