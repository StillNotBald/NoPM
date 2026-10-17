import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const WS = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  order: [] as string[],
  demo: false,
  doc: null as Record<string, unknown> | null,
  removeError: null as { message: string } | null,
}));
const requireAuthMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: requireAuthMock }));
vi.mock("@/lib/auth/demo", () => ({ isDemoActor: async () => h.demo }));
vi.mock("@/lib/audit/write", () => ({
  writeAudit: async (i: { action: string }) => {
    h.order.push(`audit:${i.action}`);
  },
}));
vi.mock("@/lib/supabase/admin", () => {
  const table = () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: h.doc, error: null });
    q.single = async () => ({ data: h.doc, error: null });
    q.update = () => {
      h.order.push("db:update");
      return q;
    };
    (q as { then: unknown }).then = (res: (v: unknown) => void) => res({ error: null });
    return q;
  };
  return {
    createAdminClient: () => ({
      from: table,
      rpc: async () => ({ data: { allowed: true, remaining: 999, retry_after_seconds: 0 }, error: null }),
      storage: {
        from: () => ({
          remove: async () => {
            h.order.push("storage:remove");
            return { error: h.removeError };
          },
          createSignedUrl: async () => ({ data: { signedUrl: "http://x" }, error: null }),
          createSignedUploadUrl: async () => ({ data: { signedUrl: "http://x", token: "t" }, error: null }),
        }),
      },
    }),
  };
});

import { DELETE, POST } from "./route";
import { POST as SIGN } from "./sign/route";

const actor = (): Actor => ({ type: "user", id: "u1", label: "U", workspaceId: WS, role: "admin", principalId: "u1" }) as Actor;
const ctx = { params: Promise.resolve({ id: DOC }) };
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  h.order.length = 0;
  h.demo = false;
  h.removeError = null;
  h.doc = { id: DOC, workspace_id: WS, storage_path: `${WS}/${DOC}/a.pdf`, file_name: "a.pdf", mime_type: "application/pdf", file_size: 10 };
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE /api/documents/:id/file", () => {
  it("updates the row and writes the audit BEFORE removing the storage object", async () => {
    const res = await DELETE(req(`/api/documents/${DOC}/file`, "DELETE"), ctx);
    expect(res.status).toBe(204);
    expect(h.order).toEqual(["db:update", "audit:document.file.remove", "storage:remove"]);
  });
  it("a failing storage remove no longer fails a request whose record is already cleared", async () => {
    h.removeError = { message: "nope" };
    const res = await DELETE(req(`/api/documents/${DOC}/file`, "DELETE"), ctx);
    expect(res.status).toBe(204);
  });
});

describe("shared demo login cannot upload (A1-3)", () => {
  it("sign and attach answer 403", async () => {
    h.demo = true;
    const body = { file_name: "a.pdf", mime_type: "application/pdf", file_size: 5, path: `${WS}/${DOC}/a.pdf` };
    const s = await SIGN(req(`/api/documents/${DOC}/file/sign`, "POST", body), ctx);
    expect(s.status).toBe(403);
    expect(((await s.json()) as { error: string }).error).toBe("Not available in the shared demo");
    const p = await POST(req(`/api/documents/${DOC}/file`, "POST", body), ctx);
    expect(p.status).toBe(403);
  });
});

describe("attach validates the exact path (A2-3)", () => {
  it("refuses a nested path under the right prefix", async () => {
    const res = await POST(
      req(`/api/documents/${DOC}/file`, "POST", { path: `${WS}/${DOC}/sub/a.pdf`, file_name: "a.pdf", mime_type: "application/pdf", file_size: 5 }),
      ctx,
    );
    expect(res.status).toBe(422);
  });
  it("refuses a path that is not the one minted for that file name", async () => {
    const res = await POST(
      req(`/api/documents/${DOC}/file`, "POST", { path: `${WS}/${DOC}/other.pdf`, file_name: "a.pdf", mime_type: "application/pdf", file_size: 5 }),
      ctx,
    );
    expect(res.status).toBe(422);
  });
});
