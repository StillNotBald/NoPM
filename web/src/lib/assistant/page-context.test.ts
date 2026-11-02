import { describe, it, expect } from "vitest";
import { resolvePageContext } from "./page-context";

const PID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function fakeDb(row: { id: string; name: string } | null) {
  const calls: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (c: string, v: unknown) => (calls.push([c, v]), q),
    maybeSingle: async () => ({ data: row }),
  };
  return { db: { from: () => q } as never, calls };
}

describe("resolvePageContext (A5)", () => {
  it("returns nothing for junk", async () => {
    expect(await resolvePageContext("x", WS, fakeDb(null).db)).toBeUndefined();
    expect(await resolvePageContext([], WS, fakeDb(null).db)).toBeUndefined();
  });

  it("keeps a project only when it is in the caller's workspace, and takes its name from the database", async () => {
    const { db, calls } = fakeDb({ id: PID, name: "Alpha" });
    const ctx = await resolvePageContext({ project_id: PID, path: "/projects/x/tasks", tz: "Asia/Singapore", name: "forged" }, WS, db);
    expect(ctx).toEqual({ project_id: PID, project_name: "Alpha", path: "/projects/x/tasks", tz: "Asia/Singapore" });
    expect(calls).toContainEqual(["workspace_id", WS]);
  });

  it("drops a project from another workspace, a bad path and a bad timezone", async () => {
    const ctx = await resolvePageContext({ project_id: PID, path: "/a b?x=<script>", tz: "nope" }, WS, fakeDb(null).db);
    expect(ctx).toBeUndefined();
  });

  it("drops a non-UUID project id without querying", async () => {
    const { db, calls } = fakeDb({ id: PID, name: "Alpha" });
    expect(await resolvePageContext({ project_id: "../x" }, WS, db)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
