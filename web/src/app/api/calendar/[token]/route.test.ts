import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createFakeAdmin,
  eqFilters,
  queriesOn,
  type FakeAdmin,
} from "@/lib/calendar/test-support";
import { FEED_MAX_EVENTS, FEED_RATE_PER_FEED, FEED_RATE_PER_IP, feedEtag } from "@/lib/calendar/feeds";

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

// ---------------------------------------------------------------------------
// Reliability: window + paging, validators, throttling
// ---------------------------------------------------------------------------

function requestWith(segment: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000/api/calendar/${segment}`, { headers });
}

function manyMilestones(n: number, offset = 0, over: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) =>
    milestoneRow({ id: `m-${String(offset + i).padStart(5, "0")}`, target_date: "2026-11-01", ...over }),
  );
}

const events = (ics: string) => ics.match(/BEGIN:VEVENT/g)?.length ?? 0;

async function fetchFeed(admin: FakeAdmin, headers: Record<string, string> = {}) {
  state.admin = admin;
  const raw = rawToken();
  return GET(requestWith(`${raw}.ics`, headers), paramsFor(`${raw}.ics`));
}

describe("the window and paging (a long-lived workspace keeps its future)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks only for milestones from 90 days back, in date order, a page at a time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T10:00:00.000Z"));
    const admin = createFakeAdmin({ calendar_feeds: [{ data: feedRow() }], milestones: [{ data: [] }] });

    await fetchFeed(admin);

    const [query] = queriesOn(admin, "milestones");
    expect(query.steps).toContainEqual({ method: "gte", args: ["target_date", "2026-07-19"] });
    const order = query.steps.filter((s) => s.method === "order").map((s) => s.args);
    expect(order).toEqual([
      ["target_date", { ascending: true }],
      ["id", { ascending: true }],
    ]);
    expect(query.steps).toContainEqual({ method: "range", args: [0, 499] });
    expect(eqFilters(query)).toEqual({ workspace_id: WS });
  });

  it("pages past the database's silent 1,000-row ceiling until the window is exhausted", async () => {
    const admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [
        { data: manyMilestones(500, 0), count: 1200 },
        { data: manyMilestones(500, 500) },
        { data: manyMilestones(200, 1000) },
      ],
    });

    const res = await fetchFeed(admin);

    expect(events(await res.text())).toBe(1200);
    const ranges = queriesOn(admin, "milestones").map((q) => q.steps.find((s) => s.method === "range")?.args);
    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
    expect(res.headers.get("X-NoPM-Feed-Truncated")).toBeNull();
  });

  it("stops at the event cap and SAYS so, with the near-term events (earliest first) kept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [
        { data: manyMilestones(500, 0), count: 5000 },
        { data: manyMilestones(500, 500) },
        { data: manyMilestones(500, 1000) },
        { data: manyMilestones(500, 1500) },
        { data: manyMilestones(500, 2000) }, // must never be asked for
      ],
    });

    const res = await fetchFeed(admin);

    expect(events(await res.text())).toBe(FEED_MAX_EVENTS);
    expect(res.headers.get("X-NoPM-Feed-Truncated")).toBe("1");
    const ranges = queriesOn(admin, "milestones").map((q) => q.steps.find((s) => s.method === "range")?.args);
    expect(ranges.at(-1)).toEqual([1500, 1999]);
    expect(ranges).toHaveLength(4);
    expect(console.warn).toHaveBeenCalled();
  });

  it("emits a milestone once even if a concurrent write shifts it across a page boundary", async () => {
    const admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [
        { data: manyMilestones(500, 0), count: 510 },
        { data: [...manyMilestones(5, 495), ...manyMilestones(10, 500)] }, // 495-499 repeat
      ],
    });
    const res = await fetchFeed(admin);
    expect(events(await res.text())).toBe(510);
  });

  it("surfaces a database error instead of serving a short calendar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = createFakeAdmin({
      calendar_feeds: [{ data: feedRow() }],
      milestones: [{ error: { message: "statement timeout" } }],
    });
    const res = await fetchFeed(admin);
    expect(res.status).toBe(500);
  });

  it("bumps an event's SEQUENCE when its PROJECT is renamed (the milestone row did not change)", async () => {
    const build = async (projectUpdatedAt: string) => {
      const admin = createFakeAdmin({
        calendar_feeds: [{ data: feedRow() }],
        milestones: [{ data: [milestoneRow({ projects: { name: "Launch", updated_at: projectUpdatedAt } })] }],
      });
      return (await (await fetchFeed(admin)).text()) as string;
    };
    const before = await build("2026-10-01T00:00:00.000Z");
    const after = await build("2026-10-17T12:00:00.000Z");
    const sequence = (ics: string) => Number(/SEQUENCE:(\d+)/.exec(ics)?.[1]);
    expect(sequence(after)).toBeGreaterThan(sequence(before));
    expect(after).toContain("DTSTAMP:20261017T120000Z");
    expect(before).toContain("DTSTAMP:20261016T083005Z"); // the milestone's own, later, write
  });
});

describe("revalidation (ETag / If-None-Match)", () => {
  const queued = () => ({ calendar_feeds: [{ data: feedRow() }], milestones: [{ data: [milestoneRow()] }] });

  it("sends a strong ETag, and the same bytes always get the same tag", async () => {
    const a = await fetchFeed(createFakeAdmin(queued()));
    const b = await fetchFeed(createFakeAdmin(queued()));
    expect(a.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(a.headers.get("ETag")).toBe(b.headers.get("ETag"));
    expect(a.headers.get("ETag")).toBe(feedEtag(await a.text()));
  });

  it("changes the tag when anything in the feed changes", async () => {
    const a = await fetchFeed(createFakeAdmin(queued()));
    const b = await fetchFeed(
      createFakeAdmin({ calendar_feeds: [{ data: feedRow() }], milestones: [{ data: [milestoneRow({ name: "Beta release (moved)" })] }] }),
    );
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
  });

  it("answers a matching If-None-Match with a body-less 304 that still carries the validators", async () => {
    const tag = (await fetchFeed(createFakeAdmin(queued()))).headers.get("ETag") as string;

    const res = await fetchFeed(createFakeAdmin(queued()), { "if-none-match": tag });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("ETag")).toBe(tag);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=900");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Type")).toBeNull();
  });

  it.each([
    ["a weak form of the tag", (t: string) => `W/${t}`],
    ["a list that contains it", (t: string) => `"nope", ${t}`],
    ["the wildcard", () => "*"],
  ])("treats %s as a match", async (_label, header) => {
    const tag = (await fetchFeed(createFakeAdmin(queued()))).headers.get("ETag") as string;
    expect((await fetchFeed(createFakeAdmin(queued()), { "if-none-match": header(tag) })).status).toBe(304);
  });

  it("serves the full calendar to a stale tag", async () => {
    const res = await fetchFeed(createFakeAdmin(queued()), { "if-none-match": '"0123456789abcdef0123456789abcdef"' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  it("still records last_fetched_at for a 304 (the subscription is alive)", async () => {
    const admin = createFakeAdmin(queued());
    const tag = (await fetchFeed(createFakeAdmin(queued()))).headers.get("ETag") as string;
    afterTasks.length = 0;
    await fetchFeed(admin, { "if-none-match": tag });
    expect(afterTasks).toHaveLength(1);
  });

  it("an unknown token never gets a 304, whatever it sends", async () => {
    const res = await fetchFeed(createFakeAdmin({ calendar_feeds: [{ data: null }] }), { "if-none-match": "*" });
    expect(res.status).toBe(404);
  });
});

describe("throttling (the route is public, so it limits itself)", () => {
  type Call = { key: string; max: number };
  function withRate(admin: FakeAdmin, decide: (call: Call) => { allowed: boolean; retry?: number } | "error") {
    const calls: Call[] = [];
    (admin.client as { rpc: unknown }).rpc = async (_fn: string, args?: Record<string, unknown>) => {
      const call = { key: String(args?.p_key), max: Number(args?.p_max) };
      calls.push(call);
      const verdict = decide(call);
      if (verdict === "error") return { data: null, error: { message: "rpc unavailable" } };
      return { data: { allowed: verdict.allowed, remaining: 0, retry_after_seconds: verdict.retry ?? 0 }, error: null };
    };
    return calls;
  }
  const queued = () => ({ calendar_feeds: [{ data: feedRow() }], milestones: [{ data: [milestoneRow()] }] });

  // One reverse proxy of ours sits in front: it appends the address it saw to x-forwarded-for.
  beforeEach(() => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "1");
    vi.stubEnv("VERCEL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts the client address before the feed is even looked up, then the feed", async () => {
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));

    const res = await fetchFeed(admin, { "x-forwarded-for": "10.9.9.9, 203.0.113.7" });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { key: "cal-ip:203.0.113.7", max: FEED_RATE_PER_IP },
      { key: "cal:cf_1", max: FEED_RATE_PER_FEED },
    ]);
  });

  it("keys on the address the trusted proxy saw: rotating the caller-writable leftmost entry buys no fresh bucket", async () => {
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));

    for (const spoof of ["1.1.1.1", "2.2.2.2", "not-an-ip", "3.3.3.3, 4.4.4.4"]) {
      await fetchFeed(admin, { "x-forwarded-for": `${spoof}, 203.0.113.7` });
    }

    expect(new Set(calls.filter((c) => c.key.startsWith("cal-ip:")).map((c) => c.key))).toEqual(new Set(["cal-ip:203.0.113.7"]));
  });

  it("with no trusted proxy configured nothing about the address can be trusted: the per-address bucket is skipped, the per-feed one still applies", async () => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "");
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));

    const res = await fetchFeed(admin, { "x-forwarded-for": "198.51.100.77" });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ key: "cal:cf_1", max: FEED_RATE_PER_FEED }]);
  });

  it("a spoofed header cannot mint counter rows when no proxy is trusted", async () => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "");
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));
    for (let i = 0; i < 5; i++) await fetchFeed(admin, { "x-forwarded-for": `198.51.100.${i}` });
    expect(calls.filter((c) => c.key.startsWith("cal-ip:"))).toHaveLength(0);
  });

  it("on Vercel the address the platform supplies is used, and x-forwarded-for is ignored", async () => {
    vi.stubEnv("VERCEL", "1");
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));

    await fetchFeed(admin, { "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "6.6.6.6" });

    expect(calls[0]).toEqual({ key: "cal-ip:198.51.100.9", max: FEED_RATE_PER_IP });
  });

  it("answers 429 with Retry-After and does no feed lookup when the address is over its limit", async () => {
    const admin = createFakeAdmin(queued());
    withRate(admin, (c) => (c.key.startsWith("cal-ip:") ? { allowed: false, retry: 23 } : { allowed: true }));

    const res = await fetchFeed(admin, { "x-forwarded-for": "203.0.113.7" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("23");
    expect(await res.json()).toEqual({ error: "Too many requests" });
    expect(queriesOn(admin, "calendar_feeds")).toHaveLength(0);
  });

  it("answers 429 and reads no milestones when one feed is polled too often", async () => {
    const admin = createFakeAdmin(queued());
    withRate(admin, (c) => (c.key === "cal:cf_1" ? { allowed: false, retry: 41 } : { allowed: true }));

    const res = await fetchFeed(admin);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("41");
    expect(queriesOn(admin, "milestones")).toHaveLength(0);
  });

  it("an unknown token only spends the address budget, and still gets the plain 404", async () => {
    const admin = createFakeAdmin({ calendar_feeds: [{ data: null }] });
    const calls = withRate(admin, () => ({ allowed: true }));
    const res = await fetchFeed(admin, { "x-forwarded-for": "203.0.113.7" });
    expect(res.status).toBe(404);
    expect(calls.map((c) => c.key)).toEqual(["cal-ip:203.0.113.7"]);
  });

  it("never puts the secret token in a rate-limit key", async () => {
    const admin = createFakeAdmin(queued());
    const calls = withRate(admin, () => ({ allowed: true }));
    const raw = rawToken();
    state.admin = admin;
    await GET(requestWith(`${raw}.ics`), paramsFor(`${raw}.ics`));
    expect(JSON.stringify(calls)).not.toContain(raw);
  });

  it("fails open when the counter is unavailable (an abuse guard, not an auth control)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const admin = createFakeAdmin(queued());
    withRate(admin, () => "error");
    expect((await fetchFeed(admin)).status).toBe(200);
  });

  it("does not throttle or touch the counter for a malformed token (no database work at all)", async () => {
    const admin = createFakeAdmin();
    const calls = withRate(admin, () => ({ allowed: false }));
    state.admin = admin;
    const res = await GET(requestWith("npc_short.ics"), paramsFor("npc_short.ics"));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
