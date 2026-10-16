import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createFakeAdmin,
  eqFilters,
  queriesOn,
  type FakeAdmin,
} from "@/lib/calendar/test-support";

// Route tests: the handler runs for real. The database and the `after()`
// scheduler are stubbed; `after` is captured so each test can run the
// last_fetched_at write explicitly. The route is auth:false, so requireAuth is
// stubbed only to prove it is never called.
const state = vi.hoisted(() => ({ admin: undefined as FakeAdmin | undefined }));
const { requireAuthMock, afterTasks } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (state.admin as FakeAdmin).client,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));

import { GET } from "./route";

const WS = "ws_1";
const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";
const MILESTONE = "3f2c1a9e-0000-4000-8000-000000000001";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function rawToken(): string {
  return `npc_${randomBytes(32).toString("base64url")}`;
}

function feedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cf_1",
    workspace_id: WS,
    name: "Team milestones",
    project_id: null,
    revoked_at: null,
    ...overrides,
  };
}

function milestoneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MILESTONE,
    project_id: PROJECT,
    name: "Beta release",
    target_date: "2026-10-30",
    status: "on_track",
    completion_pct: 40,
    description: null,
    updated_at: "2026-10-16T08:30:05.123Z",
    projects: { name: "Launch" },
    ...overrides,
  };
}

function feedRequest(segment: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/calendar/${segment}`);
}

function paramsFor(token: string) {
  return { params: Promise.resolve({ token }) };
}

async function runAfterTasks(): Promise<void> {
  for (const task of afterTasks.splice(0)) await task();
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
  vi.clearAllMocks();
  afterTasks.length = 0;
  requireAuthMock.mockReset();
});

describe("GET /api/calendar/[token]", () => {
  it("serves an ICS feed for a valid token given with the .ics suffix", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [milestoneRow()] }],
    });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(text).toContain(`UID:milestone-${MILESTONE}@nopm.example.com`);
    expect(text).toContain("SUMMARY:Launch: Beta release");
    expect(text).toContain("DTSTART;VALUE=DATE:20261030");
  });

  it.each([
    ["an object (many-to-one embed)", { name: "Launch" }, "SUMMARY:Launch: Beta release"],
    ["a one-element array", [{ name: "Launch" }], "SUMMARY:Launch: Beta release"],
    ["an empty array", [], "SUMMARY:Beta release"],
    ["null (no project embed)", null, "SUMMARY:Beta release"],
  ])("reads the project name from %s", async (_label, projects, expectedSummary) => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [milestoneRow({ projects })] }],
    });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));
    const text = await res.text();

    expect(text).toContain(expectedSummary);
  });

  it("also accepts the bare token without the suffix", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
    });

    const res = await GET(feedRequest(raw), paramsFor(raw));

    expect(res.status).toBe(200);
  });

  it("sends the calendar content type, a private 15-minute cache, and no-referrer", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
    });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=900");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("looks the feed up by the SHA-256 of the token, never by the raw token", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
    });

    await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    const [lookup] = queriesOn(state.admin as FakeAdmin, "calendar_feeds");
    expect(eqFilters(lookup)).toEqual({ token_hash: sha256(raw) });
    expect(JSON.stringify(state.admin?.queries)).not.toContain(raw);
  });

  it("scopes the milestone read to the feed's workspace and skips unscheduled rows in the query", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
    });

    await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    const [milestones] = queriesOn(state.admin as FakeAdmin, "milestones");
    expect(eqFilters(milestones)).toEqual({ workspace_id: WS });
    expect(milestones.steps).toContainEqual({ method: "not", args: ["target_date", "is", null] });
  });

  it("narrows a project feed to that project's milestones", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow({ project_id: PROJECT }) }],
      milestones: [{ data: [] }],
    });

    await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    const [milestones] = queriesOn(state.admin as FakeAdmin, "milestones");
    expect(eqFilters(milestones)).toEqual({ workspace_id: WS, project_id: PROJECT });
  });

  it("returns 404 for an unknown token", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: null }] });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(res.status).toBe(404);
    expect(queriesOn(state.admin as FakeAdmin, "milestones")).toHaveLength(0);
  });

  it("returns 404 for a revoked token and reads no milestones", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(res.status).toBe(404);
    expect(queriesOn(state.admin as FakeAdmin, "milestones")).toHaveLength(0);
  });

  it("answers an unknown and a revoked token with the same body", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({ calendar_feeds: [{ data: null }] });
    const unknown = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow({ revoked_at: "2026-10-16T09:00:00.000Z" }) }],
    });
    const revoked = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(unknown.status).toBe(revoked.status);
    expect(await unknown.text()).toBe(await revoked.text());
  });

  it.each([
    ["a token from another family", `npm_${"A".repeat(43)}.ics`],
    ["a token of the wrong length", "npc_short.ics"],
    ["a doubled suffix", `npc_${"A".repeat(43)}.ics.ics`],
    ["an empty segment", ".ics"],
  ])("returns 404 without touching the database for %s", async (_label, segment) => {
    state.admin = createFakeAdmin();

    const res = await GET(feedRequest(segment), paramsFor(segment));

    expect(res.status).toBe(404);
    expect(state.admin.queries).toHaveLength(0);
  });

  it("is unauthenticated: the secret in the URL is the credential", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
    });

    await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));

    expect(requireAuthMock).not.toHaveBeenCalled();
  });

  it("records last_fetched_at after the response, scoped to the feed and its workspace", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [] }],
      // second calendar_feeds call is the after() write; no queued result is needed
    });

    await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));
    expect(afterTasks).toHaveLength(1);

    await runAfterTasks();

    const updates = queriesOn(state.admin as FakeAdmin, "calendar_feeds").filter((q) =>
      q.steps.some((s) => s.method === "update"),
    );
    expect(updates).toHaveLength(1);
    expect(eqFilters(updates[0])).toEqual({ id: "cf_1", workspace_id: WS });
  });

  it("still omits unscheduled and impossible-date rows if the query ever returns them", async () => {
    const raw = rawToken();
    state.admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ data: [milestoneRow({ target_date: null }), milestoneRow({ id: "m2", target_date: "2027-02-29" })] }],
    });

    const res = await GET(feedRequest(`${raw}.ics`), paramsFor(`${raw}.ics`));
    const text = await res.text();

    expect(text.match(/BEGIN:VEVENT/g)).toBeNull();
  });
});
