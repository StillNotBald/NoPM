import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import {
  createFakeAdmin,
  eqFilters,
  queriesOn,
  writePayload,
  type FakeAdmin,
} from "@/lib/calendar/test-support";

// Route tests: the handler runs for real; the database, the audit writer and
// session/token resolution are stubbed (same mocking style as
// rate-limit.test.ts and guard.test.ts).
const state = vi.hoisted(() => ({ admin: undefined as FakeAdmin | undefined }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (state.admin as FakeAdmin).client,
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { DELETE } from "./route";

const WS = "ws_1";
const OWNER = "profile_owner";
const OTHER_MEMBER = "profile_other";
const ADMIN = "profile_admin";
const VIEWER = "profile_viewer";
const FEED_ID = "cf_1";

function userActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "user",
    id: OWNER,
    label: "Owner",
    workspaceId: WS,
    role: "member",
    principalId: OWNER,
    ...overrides,
  };
}

function feedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FEED_ID,
    name: "Launch feed",
    project_id: null,
    created_by: OWNER,
    created_at: "2026-10-16T08:00:00.000Z",
    last_fetched_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function deleteRequest(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/calendar-feeds/${FEED_ID}`, { method: "DELETE" });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockReset();
});

describe("DELETE /api/calendar-feeds/[id]", () => {
  it("lets the owner revoke, stamps revoked_at, and writes one calendar_feed.revoke row", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }, { data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { revoked_at: string | null } };
    expect(body.data.revoked_at).toBeTruthy();

    const [, update] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(writePayload(update)).toHaveProperty("revoked_at");
    expect(eqFilters(update)).toMatchObject({ id: FEED_ID, workspace_id: WS });

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const [audit] = writeAuditMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: WS,
      action: "calendar_feed.revoke",
      targetType: "calendar_feed",
      targetId: FEED_ID,
    });
  });

  it("never puts token_hash in the revoke response or its audit snapshot", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }, { data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(await res.text()).not.toContain("token_hash");
    expect(JSON.stringify(writeAuditMock.mock.calls)).not.toContain("token_hash");
  });

  it("refuses a member who did not create the feed (403, nothing written)", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: OTHER_MEMBER, principalId: OTHER_MEMBER }));

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(403);
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("lets a workspace admin revoke a feed they did not create", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }, { data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: ADMIN, principalId: ADMIN, role: "admin" }));

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(200);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("lets a viewer revoke their OWN feed (Q-ACC-19)", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow({ created_by: VIEWER }) }, { data: feedRow({ created_by: VIEWER, revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: VIEWER, principalId: VIEWER, role: "viewer" }));

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(200);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("still refuses a viewer on a feed they did not create", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: VIEWER, principalId: VIEWER, role: "viewer" }));

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(403);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("lets a token revoke a feed minted by its principal", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }, { data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce({
      type: "token",
      id: "tok_1",
      label: "agent",
      workspaceId: WS,
      scopes: ["milestone:write"],
      principalId: OWNER,
    } satisfies Actor);

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(200);
  });

  it("refuses a token with no recorded owner, even one with milestone:write", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce({
      type: "token",
      id: "tok_2",
      label: "legacy",
      workspaceId: WS,
      scopes: ["milestone:write"],
      principalId: null,
    } satisfies Actor);

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(403);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("refuses a second revoke as a rule violation, with no write and no audit row", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("already_revoked");
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("refuses when a concurrent revoke wins the compare-and-set, with no audit row", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }, { data: null }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await DELETE(deleteRequest(), paramsFor(FEED_ID));

    expect(res.status).toBe(422);
    const [, update] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(update.steps.some((s) => s.method === "is" && s.args[0] === "revoked_at" && s.args[1] === null)).toBe(true);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a feed that is not in the caller's workspace", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: null }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await DELETE(deleteRequest(), paramsFor("cf_elsewhere"));

    expect(res.status).toBe(404);
    const [lookup] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(eqFilters(lookup)).toMatchObject({ id: "cf_elsewhere", workspace_id: WS });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});
