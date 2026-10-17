import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import {
  createFakeAdmin,
  eqFilters,
  queriesOn,
  selectedColumns,
  writePayload,
  type FakeAdmin,
} from "@/lib/calendar/test-support";

// Route tests: the handlers run for real; only the database, the audit writer
// and session/token resolution are stubbed. Audit and the admin client are
// mocked the same way rate-limit.test.ts and guard.test.ts mock them.
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

import { GET, POST } from "./route";

const WS = "ws_1";
const MEMBER = "profile_member";
const VIEWER = "profile_viewer";
const OTHER_MEMBER = "profile_other";
const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function userActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "user",
    id: MEMBER,
    label: "Member",
    workspaceId: WS,
    role: "member",
    principalId: MEMBER,
    ...overrides,
  };
}

function tokenActor(overrides: Partial<Actor> = {}): Actor {
  return {
    type: "token",
    id: "tok_1",
    label: "agent",
    workspaceId: WS,
    scopes: ["milestone:write", "milestone:read", "project:read"],
    principalId: MEMBER,
    ...overrides,
  };
}

function feedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cf_1",
    name: "Launch feed",
    project_id: null,
    created_by: MEMBER,
    created_at: "2026-10-16T08:00:00.000Z",
    last_fetched_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/calendar-feeds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/calendar-feeds${query}`);
}

const NO_PARAMS = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.clearAllMocks();
  requireAuthMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/calendar-feeds", () => {
  it("mints a feed for a member, returns the URL once, and stores only the hash", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> & { url: string } };
    expect(body.data.url).toMatch(/^http:\/\/localhost:3000\/api\/calendar\/npc_[A-Za-z0-9_-]{43}\.ics$/);

    const raw = body.data.url.slice("http://localhost:3000/api/calendar/".length, -".ics".length);
    const insert = writePayload(queriesOn(state.admin as FakeAdmin, "calendar_feeds")[0]);
    expect(insert).toMatchObject({
      workspace_id: WS,
      name: "Launch feed",
      project_id: null,
      created_by: MEMBER,
    });
    expect(insert?.token_hash).toBe(sha256(raw));
    expect(JSON.stringify(insert)).not.toContain(raw);
  });

  it("never returns token_hash in the response", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);
    const text = await res.text();

    expect(text).not.toContain("token_hash");
  });

  it("writes exactly one calendar_feed.create audit row without the raw token", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);
    const { data } = (await res.json()) as { data: { url: string } };

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const [audit] = writeAuditMock.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      workspaceId: WS,
      action: "calendar_feed.create",
      targetType: "calendar_feed",
      targetId: "cf_1",
    });
    expect(JSON.stringify(audit)).not.toContain(data.url);
  });

  it("scopes a project-narrowed feed to a project in the caller's workspace", async () => {
    state.admin = createFakeAdmin({
      projects: [{ data: { id: PROJECT } }],
      calendar_feeds: [{ data: feedRow({ project_id: PROJECT }) }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await POST(postRequest({ name: "Launch feed", project_id: PROJECT }), NO_PARAMS);

    expect(res.status).toBe(201);
    const projectLookup = queriesOn(state.admin as FakeAdmin, "projects")[0];
    expect(eqFilters(projectLookup)).toMatchObject({ id: PROJECT, workspace_id: WS });
    expect(writePayload(queriesOn(state.admin as FakeAdmin, "calendar_feeds")[0])?.project_id).toBe(PROJECT);
  });

  it("rejects a project that is not in the caller's workspace, with nothing written", async () => {
    state.admin = createFakeAdmin({ projects: [{ data: null }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await POST(postRequest({ name: "Launch feed", project_id: PROJECT }), NO_PARAMS);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Array<{ field: string }> };
    expect(body.fields[0].field).toBe("project_id");
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("rejects a blank name and a non-UUID project_id", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValue(userActor());

    const blank = await POST(postRequest({ name: "   " }), NO_PARAMS);
    const badProject = await POST(postRequest({ name: "x", project_id: "not-a-uuid" }), NO_PARAMS);

    expect(blank.status).toBe(422);
    expect(badProject.status).toBe(422);
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("refuses a viewer, with nothing written", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(userActor({ id: VIEWER, principalId: VIEWER, role: "viewer" }));

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

    expect(res.status).toBe(403);
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("refuses a read-only token: minting a feed needs milestone:write", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(tokenActor({ scopes: ["milestone:read"] }));

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

    expect(res.status).toBe(403);
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
  });

  it("refuses a token holding milestone:write but not milestone:read or project:read: the feed exports both", async () => {
    for (const scopes of [["milestone:write"], ["milestone:write", "milestone:read"], ["milestone:write", "project:read"]]) {
      state.admin = createFakeAdmin();
      requireAuthMock.mockResolvedValueOnce(tokenActor({ scopes }));

      const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

      expect(res.status).toBe(403);
      expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    }
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("owns a token-minted feed as the token's principal, not the token id", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }] });
    requireAuthMock.mockResolvedValueOnce(tokenActor());

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

    expect(res.status).toBe(201);
    expect(writePayload(queriesOn(state.admin as FakeAdmin, "calendar_feeds")[0])?.created_by).toBe(MEMBER);
  });

  it("refuses a legacy token with no recorded owner (fail-closed, nothing written)", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(tokenActor({ principalId: null }));

    const res = await POST(postRequest({ name: "Launch feed" }), NO_PARAMS);

    expect(res.status).toBe(403);
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/calendar-feeds", () => {
  it("lists only the caller's active feeds, without the token hash column", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ count: 1 }, { data: [feedRow()] }],
    });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await GET(getRequest(), NO_PARAMS);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; total: number; page: number; limit: number };
    expect(body).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(body.data).toHaveLength(1);

    const [countQuery, listQuery] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    for (const query of [countQuery, listQuery]) {
      expect(eqFilters(query)).toMatchObject({ workspace_id: WS, created_by: MEMBER });
    }
    expect(selectedColumns(listQuery)).not.toContain("token_hash");
  });

  it("lists nothing for a token with no recorded owner, without querying", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(tokenActor({ principalId: null, scopes: ["milestone:read"] }));

    const res = await GET(getRequest(), NO_PARAMS);
    const body = (await res.json()) as { data: unknown[]; total: number };

    expect(body).toMatchObject({ data: [], total: 0 });
    expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
  });

  it("lets a viewer read their own feeds", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ count: 0 }, { data: [] }] });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: VIEWER, principalId: VIEWER, role: "viewer" }));

    const res = await GET(getRequest(), NO_PARAMS);

    expect(res.status).toBe(200);
  });

  it("refuses a token without milestone:read", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(tokenActor({ scopes: ["task:read"] }));

    const res = await GET(getRequest(), NO_PARAMS);

    expect(res.status).toBe(403);
  });

  it("clamps the page size to 100 and the page to at least 1", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ count: 0 }, { data: [] }] });
    requireAuthMock.mockResolvedValueOnce(userActor());

    const res = await GET(getRequest("?page=0&limit=500"), NO_PARAMS);
    const body = (await res.json()) as { page: number; limit: number };

    expect(body).toMatchObject({ page: 1, limit: 100 });
  });

  it("does not surface another member's feeds (filtered on created_by)", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ count: 0 }, { data: [] }] });
    requireAuthMock.mockResolvedValueOnce(userActor({ id: OTHER_MEMBER, principalId: OTHER_MEMBER }));

    await GET(getRequest(), NO_PARAMS);

    const [, listQuery] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(eqFilters(listQuery).created_by).toBe(OTHER_MEMBER);
  });
});

describe("GET /api/calendar-feeds?scope=workspace", () => {
  const ADMIN = "profile_admin";
  const adminActor = () => userActor({ id: ADMIN, principalId: ADMIN, role: "admin" });

  it("lets an admin list every member's feeds, with owner names and no token material", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [
        { count: 2 },
        { data: [feedRow({ id: "cf_1", created_by: MEMBER }), feedRow({ id: "cf_2", created_by: OTHER_MEMBER })] },
      ],
      profiles: [
        {
          data: [
            { id: MEMBER, display_name: "Mia Member" },
            { id: OTHER_MEMBER, display_name: "Ola Departed" },
          ],
        },
      ],
    });
    requireAuthMock.mockResolvedValueOnce(adminActor());

    const res = await GET(getRequest("?scope=workspace"), NO_PARAMS);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("token");
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(2);
    expect(body.data.map((r) => [r.created_by, r.owner_name])).toEqual([
      [MEMBER, "Mia Member"],
      [OTHER_MEMBER, "Ola Departed"],
    ]);

    const [countQuery, listQuery] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    for (const query of [countQuery, listQuery]) {
      expect(eqFilters(query)).toEqual({ workspace_id: WS });
    }
    expect(selectedColumns(listQuery)).not.toContain("token_hash");
    const profileQuery = queriesOn(state.admin as FakeAdmin, "profiles")[0];
    expect(selectedColumns(profileQuery)).toBe("id, display_name");
  });

  it("keeps a feed whose owner profile is gone (owner_name null) so it can still be revoked", async () => {
    state.admin = createFakeAdmin({
      calendar_feeds: [{ count: 1 }, { data: [feedRow({ created_by: OTHER_MEMBER })] }],
      profiles: [{ data: [] }],
    });
    requireAuthMock.mockResolvedValueOnce(adminActor());

    const res = await GET(getRequest("?scope=workspace"), NO_PARAMS);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    expect(body.data[0]).toMatchObject({ created_by: OTHER_MEMBER, owner_name: null });
  });

  it("refuses a non-admin member and a token, with no feed query", async () => {
    for (const actor of [userActor(), tokenActor()]) {
      state.admin = createFakeAdmin();
      requireAuthMock.mockResolvedValueOnce(actor);

      const res = await GET(getRequest("?scope=workspace"), NO_PARAMS);

      expect(res.status).toBe(403);
      expect(queriesOn(state.admin as FakeAdmin, "calendar_feeds")).toHaveLength(0);
    }
  });

  it("an admin without ?scope still sees only their own feeds", async () => {
    state.admin = createFakeAdmin({ calendar_feeds: [{ count: 0 }, { data: [] }] });
    requireAuthMock.mockResolvedValueOnce(adminActor());

    await GET(getRequest(), NO_PARAMS);

    const [, listQuery] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(eqFilters(listQuery)).toMatchObject({ created_by: ADMIN });
  });

  it("rejects an unknown scope value", async () => {
    state.admin = createFakeAdmin();
    requireAuthMock.mockResolvedValueOnce(adminActor());

    const res = await GET(getRequest("?scope=everything"), NO_PARAMS);

    expect(res.status).toBe(422);
  });
});
