import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// Deleting an open change request closes the approval cards that went out for
// it. The route runs for real against the hub's in-memory database; auth, the
// audit writer, the platform adapter and `after()` (captured) are stubbed.
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
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));

import { clearAdapters, registerAdapter } from "@/lib/integrations/deliveries";
import { runApprovalRequested } from "@/lib/integrations/emit";
import {
  FakeDb,
  REQUEST_VERSION,
  TEST_ENCRYPTION_KEY,
  WS,
  createFakeAdapter,
  ids,
  linkIdentity,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import type { ApprovalEvent } from "@/lib/integrations/types";
import { DELETE, PATCH } from "./route";

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

const remove = (id = ids.approval) =>
  DELETE(new NextRequest(`http://localhost:3000/api/change-requests/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
const runAfterTasks = async () => {
  for (const task of afterTasks.splice(0)) await task();
};
const openEvent: ApprovalEvent = {
  workspaceId: WS,
  kind: "change_request",
  id: ids.approval,
  title: "Change request CR-001: Rename a label",
  summary: null,
  projectId: null,
  projectName: null,
  requestedByLabel: "Rae Requester",
  requesterPrincipalId: ids.requester,
  version: REQUEST_VERSION,
};

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
  Object.assign(db.rows("change_requests")[0], {
    reference_id: "CR-001",
    title: "Rename a label",
    description: null,
    impact_summary: null,
    project_id: null,
    requested_by_label: "Rae Requester",
    requested_by_type: "user",
    requested_principal_id: ids.requester,
  });
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
  linkIdentity(db, ids.manager, "ou_max");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const edit = (body: Record<string, unknown>, id = ids.approval) =>
  PATCH(
    new NextRequest(`http://localhost:3000/api/change-requests/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
const crRow = () => db.rows("change_requests")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A person other than the requester who may still hold change:write (an approver, say). */
const approver = (): Actor => ({
  type: "user",
  id: ids.manager,
  label: "Max Manager",
  workspaceId: WS,
  role: "manager",
  principalId: ids.manager,
});
const token = (owner: string | null, id = "tok-1"): Actor => ({
  type: "token",
  id,
  tokenId: id,
  label: "ci-agent",
  workspaceId: WS,
  scopes: ["change:write"],
  principalId: owner,
  channel: "api",
});

describe("who may edit or delete an open change request: only the requester's person", () => {
  it("a different person cannot rewrite a pending request (403 not_requester), and nothing changes", async () => {
    requireAuthMock.mockResolvedValue(approver());

    const res = await edit({ title: "Something the approver would rather approve", impact_cost: 1 });
    const body = (await res.json()) as { error: string; code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("not_requester");
    expect(body.error).toMatch(/Only the requester can edit an open change request; raise a new one instead/);
    expect(crRow()).toMatchObject({ title: "Rename a label", status: "raised" });
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it("a different person cannot delete a pending request either, and no card is closed", async () => {
    requireAuthMock.mockResolvedValue(approver());

    const res = await remove();

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("not_requester");
    expect(db.rows("change_requests")).toHaveLength(1);
    expect(afterTasks).toHaveLength(0);
  });

  it("the requester may edit it", async () => {
    const res = await edit({ title: "Rename two labels" });
    expect(res.status).toBe(200);
    expect(crRow().title).toBe("Rename two labels");
  });

  it("a token minted by the requester acts for the same person and may edit and delete it", async () => {
    requireAuthMock.mockResolvedValue(token(ids.requester));
    expect((await edit({ title: "Edited by my agent" })).status).toBe(200);
    expect(crRow().title).toBe("Edited by my agent");
    expect((await remove()).status).toBe(204);
  });

  it("a token minted by someone else cannot", async () => {
    requireAuthMock.mockResolvedValue(token(ids.manager));
    expect((await edit({ title: "Edited by another person's agent" })).status).toBe(403);
    expect((await remove()).status).toBe(403);
    expect(crRow().title).toBe("Rename a label");
  });

  it("a token with no recorded owner is refused outright (no human behind it to compare)", async () => {
    requireAuthMock.mockResolvedValue(token(null));
    const res = await edit({ title: "Edited by an ownerless token" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("no_principal");
  });

  it("a legacy request with no recorded requester can still be edited (there is nobody to compare)", async () => {
    crRow().requested_principal_id = null;
    requireAuthMock.mockResolvedValue(approver());
    expect((await edit({ title: "Edited" })).status).toBe(200);
  });

  it("a decided request stays 422 for everybody (the decision record is never rewritten), not 403", async () => {
    crRow().status = "approved";
    requireAuthMock.mockResolvedValue(approver());
    expect((await edit({ title: "x" })).status).toBe(422);
    expect((await remove()).status).toBe(422);
  });
});

describe("Q1: an emergency request commits when raised, so it is part of the record at once", () => {
  it("edit and delete are refused (422) on a committed emergency request, whether approved or implemented", async () => {
    Object.assign(crRow(), { status: "approved", tier: "emergency", is_emergency: true });
    expect((await edit({ title: "Prod is down (fixed wording)" })).status).toBe(422);
    expect((await remove()).status).toBe(422);
  });

  it("once it is live (implemented) it is part of the record: 422 for edit and delete", async () => {
    Object.assign(crRow(), { status: "implemented", tier: "emergency", is_emergency: true });
    expect((await edit({ title: "x" })).status).toBe(422);
    expect((await remove()).status).toBe(422);
  });

});

describe("DELETE /api/change-requests/[id] — approval cards for the deleted request", () => {
  it("kills the card's token and patches the card, instead of leaving live buttons for a request that is gone", async () => {
    await runApprovalRequested(openEvent);
    expect(fake.calls.sends).toHaveLength(1);
    expect(db.rows("action_tokens").filter((t) => t.used_at === null)).toHaveLength(1);

    const res = await remove();
    expect(res.status).toBe(204);
    expect(db.rows("change_requests")).toHaveLength(0);

    await runAfterTasks();

    expect(db.rows("action_tokens").every((t) => t.used_at !== null)).toBe(true);
    expect(fake.calls.updates).toEqual([{ externalMessageId: "om_1", body: { card: "decided", status: "withdrawn" } }]);
  });

  it("a card that was still waiting to be sent is never sent", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    await runApprovalRequested(openEvent);
    const waiting = db.rows("integration_deliveries").find((d) => d.kind === "approval_card")!;
    expect(waiting.status).toBe("retry");

    await remove();
    await runAfterTasks();

    expect(db.rows("integration_deliveries").find((d) => d.id === waiting.id)?.status).toBe("superseded");
  });

  it("does not announce anything when the delete is refused (the request was decided meanwhile)", async () => {
    db.rows("change_requests")[0].status = "approved";
    const res = await remove();
    expect(res.status).toBe(422);
    expect(afterTasks).toHaveLength(0);
  });

  it("a request nobody was sent a card for is deleted all the same", async () => {
    const res = await remove();
    expect(res.status).toBe(204);
    await runAfterTasks();
    expect(fake.calls.updates).toHaveLength(0);
  });
});
