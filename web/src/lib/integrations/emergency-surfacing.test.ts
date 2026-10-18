import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// W4-09: emergency changes (not yet live, or live and owing their retro decision) are "pending" for the
// chat hub: the card is still actionable and the catch-up re-announces it.
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

describe("a card for an emergency change stays actionable until the retro decision", () => {
  it("status emergency is pending", async () => {
    db.seed("change_requests", [cr("e1", { status: "emergency", tier: "emergency", is_emergency: true })]);
    expect(await stateOf("e1")).toBe("pending");
  });

  it("a live emergency (implemented) still owing its retro decision is pending; once decided it is not", async () => {
    db.seed("change_requests", [
      cr("e2", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: null }),
      cr("e3", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: "2026-10-19T00:00:00.000Z" }),
    ]);
    expect(await stateOf("e2")).toBe("pending");
    expect(await stateOf("e3")).toBe("decided");
  });

  it("an ordinary implemented change is decided", async () => {
    db.seed("change_requests", [cr("n1", { status: "implemented", is_emergency: false })]);
    expect(await stateOf("n1")).toBe("decided");
  });
});

describe("catch-up re-announces emergencies that wait", () => {
  it("includes status emergency and live-awaiting-retro, not a decided emergency or an ordinary implemented change", async () => {
    db.seed("change_requests", [
      cr("e1", { status: "emergency", tier: "emergency", is_emergency: true }),
      cr("e2", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: null }),
      cr("e3", { status: "implemented", tier: "emergency", is_emergency: true, retro_decided_at: "2026-10-19T00:00:00.000Z" }),
      cr("n1", { status: "implemented", is_emergency: false }),
      cr("r1", { status: "raised" }),
    ]);
    await catchUpPendingApprovals(WS);
    const ids = emitted.requested.filter((e) => e.kind === "change_request").map((e) => e.id).sort();
    expect(ids).toEqual(["e1", "e2", "r1"]);
  });
});
