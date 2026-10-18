import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  apiGet: apiGetMock,
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { fetchFeeds, fetchWorkspaceFeeds } from "./api";

const rows = (from: number, n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `cf_${from + i}`,
    name: `Feed ${from + i}`,
    project_id: null,
    created_by: "p1",
    created_at: "2026-10-16T08:00:00.000Z",
    last_fetched_at: null,
    revoked_at: null,
    ...extra,
  }));

beforeEach(() => apiGetMock.mockReset());

describe("calendar feed fetchers", () => {
  it("pages through every result instead of stopping at the server's default 20", async () => {
    apiGetMock
      .mockResolvedValueOnce(rows(0, 100))
      .mockResolvedValueOnce(rows(100, 100))
      .mockResolvedValueOnce(rows(200, 7));

    const feeds = await fetchFeeds();

    expect(feeds).toHaveLength(207);
    expect(apiGetMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/calendar-feeds?page=1&limit=100",
      "/api/calendar-feeds?page=2&limit=100",
      "/api/calendar-feeds?page=3&limit=100",
    ]);
  });

  it("asks for the workspace-wide view and carries each owner's name", async () => {
    apiGetMock.mockResolvedValueOnce([
      ...rows(0, 1, { created_by: "p9", owner_name: "Ola Departed" }),
      ...rows(1, 1, { created_by: "p10" }),
    ]);

    const feeds = await fetchWorkspaceFeeds();

    expect(apiGetMock).toHaveBeenCalledWith("/api/calendar-feeds?scope=workspace&page=1&limit=100");
    expect(feeds.map((f) => [f.ownerId, f.ownerName])).toEqual([
      ["p9", "Ola Departed"],
      ["p10", null],
    ]);
  });

  it("hides revoked rows", async () => {
    apiGetMock.mockResolvedValueOnce([...rows(0, 1), ...rows(1, 1, { revoked_at: "2026-10-17T00:00:00Z" })]);
    expect(await fetchFeeds()).toHaveLength(1);
  });
});
