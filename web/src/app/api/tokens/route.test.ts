/**
 * GET /api/tokens — the human Tokens list hides ONLY the assistant's own
 * ephemeral tokens, identified by the `kind` column, never by name (R1 S1.hide).
 *
 * A token named "AI Assistant · build" minted through POST /api/tokens used to
 * vanish from the inventory because the list filtered on the name prefix; it was
 * revocable only by id. Now the name is just a label: such a token is listed,
 * and a genuine assistant token (kind = 'assistant', set only by the assistant's
 * mint path) stays hidden. POST has no way to set `kind`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

type Row = Record<string, unknown>;

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { rows: [] as Row[], inserted: [] as Row[] },
  authHolder: { actor: null as unknown },
}));

/** Just enough of the query builder for the list + insert paths of this route. */
function table(name: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let head = false;
  let insert: Row | null = null;
  const builder = {
    select(_cols?: string, opts?: { head?: boolean }) {
      head = !!opts?.head;
      return builder;
    },
    eq(col: string, v: unknown) {
      filters.push((r) => r[col] === v);
      return builder;
    },
    neq(col: string, v: unknown) {
      filters.push((r) => r[col] !== v);
      return builder;
    },
    not() {
      throw new Error("the list must not filter by name (not/ilike)");
    },
    order() {
      return builder;
    },
    range() {
      return builder;
    },
    insert(row: Row) {
      insert = { id: `${name}-${holder.inserted.length + 1}`, ...row };
      if (name === "api_tokens") holder.inserted.push(insert);
      return builder;
    },
    single: async () => ({ data: insert, error: null }),
    then(resolve: (v: unknown) => unknown) {
      if (name === "audit_log") return resolve({ data: null, error: null });
      const matched = holder.rows.filter((r) => filters.every((f) => f(r)));
      return resolve(head ? { count: matched.length, data: null, error: null } : { data: matched, count: matched.length, error: null });
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (name: string) => table(name),
    rpc: async () => ({ data: { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null }),
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { GET, POST } from "./route";

const WS = "ws-1";
const manager: Actor = {
  type: "user",
  id: "11111111-1111-4111-8111-111111111111",
  label: "Manager",
  workspaceId: WS,
  role: "manager",
  principalId: "11111111-1111-4111-8111-111111111111",
  channel: "ui",
  requestId: "req-1",
};

const tok = (over: Row): Row => ({
  workspace_id: WS,
  prefix: "npm_abcd",
  scopes: ["task:read"],
  revoked: false,
  created_at: "2026-10-17T00:00:00Z",
  ...over,
});

beforeEach(() => {
  authHolder.actor = manager;
  holder.inserted = [];
  holder.rows = [
    tok({ id: "t-plain", name: "CI bot", kind: "user" }),
    tok({ id: "t-lookalike", name: "AI Assistant · build", kind: "user" }), // a manager's token with the assistant's name
    tok({ id: "t-ephemeral", name: "AI Assistant · Pat", kind: "assistant" }),
    tok({ id: "t-other-ws", workspace_id: "ws-2", name: "Foreign", kind: "user" }),
  ];
});

const list = async () => {
  const res = await GET(new NextRequest("http://localhost/api/tokens"), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
};

describe("GET /api/tokens", () => {
  it("lists a token that merely has the assistant's NAME, hides only kind = 'assistant'", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data.map((t: Row) => t.id).sort()).toEqual(["t-lookalike", "t-plain"]);
    expect(body.total).toBe(2);
  });

  it("never lists another workspace's tokens", async () => {
    const { body } = await list();
    expect(body.data.map((t: Row) => t.id)).not.toContain("t-other-ws");
  });

  it("still requires an admin/manager session", async () => {
    authHolder.actor = { ...manager, role: "member" };
    const { status } = await list();
    expect(status).toBe(403);
  });
});

describe("POST /api/tokens cannot mint a hidden token", () => {
  it("ignores a client-supplied kind: the row is written without one (column default 'user')", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "AI Assistant · sneaky", scopes: ["task:read"], kind: "assistant" }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(201);
    expect(holder.inserted).toHaveLength(1);
    expect("kind" in holder.inserted[0]).toBe(false);
  });
});

describe("migration 0052 (api_tokens.kind)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261017000052_api_tokens_kind.sql"), "utf8")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  it("adds kind as NOT NULL, defaulting to 'user', limited to user | assistant", () => {
    expect(sql).toContain("alter table api_tokens add column if not exists kind text not null default 'user'");
    expect(sql).toContain("check (kind in ('user', 'assistant'))");
  });

  it("backfills only rows that also look like the assistant's mint (name prefix AND expiry within an hour)", () => {
    expect(sql).toMatch(/update api_tokens set kind = 'assistant' where kind = 'user' and name like 'ai assistant ' \|\| chr\(183\) \|\| '%' and expires_at is not null and expires_at <= created_at \+ interval '61 minutes'/);
  });
});
