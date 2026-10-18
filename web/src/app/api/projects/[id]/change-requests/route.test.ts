import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// Raising a change request tells the Integration Hub which CONTENT VERSION the
// approval card describes. The route runs for real, against the hub's in-memory
// database; only auth, the audit writer, the platform adapter and `after()`
// (captured, so the test decides when the card goes out) are stubbed.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock, afterTasks } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
// The FakeDb has no reference counter; the allocator has its own tests (next-ref.test.ts).
let refSeq = 0;
vi.mock("@/lib/governance/next-ref", () => ({
  insertWithReference: async (_db: unknown, _ws: string, _kind: string, insert: (ref: string) => PromiseLike<unknown>) =>
    insert(`CR-${String(++refSeq).padStart(3, "0")}`),
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));

import { clearAdapters, registerAdapter } from "@/lib/integrations/deliveries";
import {
  FakeDb,
  TEST_ENCRYPTION_KEY,
  WS,
  createFakeAdapter,
  ids,
  linkIdentity,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import { POST } from "./route";

const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";
const requester = (): Actor => ({
  type: "user",
  id: ids.requester,
  label: "Rae Requester",
  workspaceId: WS,
  role: "manager",
  principalId: ids.requester,
});

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

const raise = (body: Record<string, unknown> = { title: "Rename a label" }) =>
  POST(
    new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/change-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROJECT }) },
  );
const runAfterTasks = async () => {
  for (const task of afterTasks.splice(0)) await task();
};
const cardRows = () => db.rows("integration_deliveries").filter((d) => d.kind === "approval_card") as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  afterTasks.length = 0;
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(requester());
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: PROJECT, workspace_id: WS, name: "Apollo" }]);
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
  linkIdentity(db, ids.manager, "ou_max");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/projects/[id]/change-requests — the hub event carries the content version", () => {
  it("stamps the card's event with the new row's updated_at, so the card can only ever be bound to what it shows", async () => {
    const res = await raise();
    const body = (await res.json()) as { data: { id: string; updated_at: string } };
    expect(res.status).toBe(201);
    expect(body.data.updated_at).toBeTruthy();

    await runAfterTasks();

    expect(cardRows()).toHaveLength(1);
    expect(cardRows()[0].payload.event).toMatchObject({ kind: "change_request", id: body.data.id, version: body.data.updated_at });
    expect(db.rows("action_tokens")[0].approval_version).toBe(body.data.updated_at);
  });

  it("an edit that lands before the card goes out is never approvable unseen: the stale card is not sent", async () => {
    const res = await raise({ title: "Rename a label" });
    const { data } = (await res.json()) as { data: { id: string } };

    // The requester edits the request in the window between the raise and the first card.
    const stored = db.rows("change_requests").find((r) => r.id === data.id)!;
    stored.title = "Delete production";
    stored.updated_at = new Date(Date.parse(stored.updated_at as string) + 5000).toISOString();

    await runAfterTasks();

    expect(cardRows()).toHaveLength(1);
    expect(cardRows()[0]).toMatchObject({ status: "superseded", last_error: "request changed before delivery" });
    expect(fake.calls.sends).toHaveLength(0);
    expect(db.rows("action_tokens")).toHaveLength(0);
  });
});
