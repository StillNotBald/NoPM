import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Q1: an emergency change commits when raised, so its card is never actionable and the catch-up never re-announces it.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
const emitted = vi.hoisted(() => ({ requested: [] as Record<string, unknown>[] }));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: Record<string, unknown>) => void emitted.requested.push(ev),
  runApprovalRequested: async (ev: Record<string, unknown>) => void emitted.requested.push(ev),
  emitApprovalDecided: () => {},
  emitApprovalChanged: () => {},
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, seedWorkspace } from "./test-support";
import { readRequest } from "./deliveries";
import { catchUpPendingApprovals } from "./catchup";

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  emitted.requested.length = 0;
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.tables.change_requests = [];
  db.tables.deletion_requests = [];
});
afterEach(() => vi.unstubAllEnvs());

const cr = (id: string, over: Record<string, unknown>) => ({
  id,
  workspace_id: WS,
  reference_id: id.toUpperCase(),
  title: id,
  status: "raised",
  tier: "normal",
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
  ...over,
});
const stateOf = async (id: string) => (await readRequest({ workspace_id: WS, approval_kind: "change_request", approval_id: id })).state;

describe("Q1: a card for an emergency change is decided, never pending", () => {
  it("a committed emergency (approved) is decided", async () => {
    db.seed("change_requests", [cr("e1", { status: "approved", tier: "emergency", is_emergency: true, retro_decided_at: "2026-10-18T00:00:00.000Z" })]);
    expect(await stateOf("e1")).toBe("decided");
  });

  it("a live emergency (implemented) is decided, whether or not it was ever retro-decided", async () => {
    db.seed("change_requests", [
      cr("e2", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: null }),
      cr("e3", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: "2026-10-19T00:00:00.000Z" }),
    ]);
    expect(await stateOf("e2")).toBe("decided");
    expect(await stateOf("e3")).toBe("decided");
  });

  it("an ordinary raised change is still pending", async () => {
    db.seed("change_requests", [cr("r1", { status: "raised" })]);
    expect(await stateOf("r1")).toBe("pending");
  });
});

describe("catch-up leaves emergencies alone", () => {
  it("announces only raised and under-review changes", async () => {
    db.seed("change_requests", [
      cr("e1", { status: "approved", tier: "emergency", is_emergency: true }),
      cr("e2", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: null }),
      cr("n1", { status: "implemented", is_emergency: false }),
      cr("r1", { status: "raised" }),
      cr("u1", { status: "under_review" }),
    ]);
    await catchUpPendingApprovals(WS);
    const ids = emitted.requested.filter((e) => e.kind === "change_request").map((e) => e.id).sort();
    expect(ids).toEqual(["r1", "u1"]);
  });
});
