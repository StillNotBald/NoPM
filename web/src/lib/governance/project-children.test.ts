import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHILD_COUNTS_KEY, SCOPE_KEY, countsOnly, projectChildCounts } from "./project-children";

function dbReturning(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

describe("projectChildCounts", () => {
  it("asks the SQL function for the project's counts + fingerprint and returns them untouched", async () => {
    const snapshot = {
      tasks: 3,
      milestones: 1,
      [SCOPE_KEY]: { project: "abc", ids: { tasks: "def", milestones: "ghi" } },
    };
    const { db, rpc } = dbReturning({ data: snapshot, error: null });
    await expect(projectChildCounts(db, "proj-1")).resolves.toEqual(snapshot);
    expect(rpc).toHaveBeenCalledWith("nopm_project_child_counts", { p_project_id: "proj-1" });
  });

  it("fails closed: an RPC error means no snapshot, so no deletion request", async () => {
    const { db } = dbReturning({ data: null, error: { message: "boom" } });
    await expect(projectChildCounts(db, "proj-1")).rejects.toThrow("Could not snapshot the project's contents: boom");
  });

  it("an empty answer is an empty snapshot, not a crash", async () => {
    const { db } = dbReturning({ data: null, error: null });
    await expect(projectChildCounts(db, "proj-1")).resolves.toEqual({});
  });
});

describe("snapshot shape", () => {
  it("the key the route stores it under is the one the trigger reads, and the fingerprint key is reserved", () => {
    expect(CHILD_COUNTS_KEY).toBe("child_counts");
    expect(SCOPE_KEY).toBe("_scope");
  });

  it("countsOnly drops the fingerprint and keeps every per-table count", () => {
    expect(
      countsOnly({ tasks: 2, risks: 0, [SCOPE_KEY]: { project: null, ids: { tasks: "x" } } }),
    ).toEqual({ tasks: 2, risks: 0 });
    expect(countsOnly({ tasks: 2 })).toEqual({ tasks: 2 });
  });
});
