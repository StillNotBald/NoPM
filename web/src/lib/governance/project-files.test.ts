import { describe, it, expect, vi, beforeEach } from "vitest";

const { removed, state } = vi.hoisted(() => ({
  removed: { calls: [] as string[][] },
  state: { fail: false, throws: false },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          if (bucket !== "documents") throw new Error("wrong bucket");
          if (state.throws) throw new Error("network");
          removed.calls.push(paths);
          return { data: null, error: state.fail ? { message: "denied" } : null };
        },
      }),
    },
  }),
}));

import { removeStoredFiles } from "./project-files";

const WS = "ws-1";

beforeEach(() => {
  removed.calls = [];
  state.fail = false;
  state.throws = false;
});

describe("removeStoredFiles (decision 20)", () => {
  it("removes only string paths inside the workspace folder, without traversal", async () => {
    await removeStoredFiles([`${WS}/d1/a.pdf`, "ws-2/d9/b.pdf", `${WS}/d2/../x`, 7, null], WS);
    expect(removed.calls).toEqual([[`${WS}/d1/a.pdf`]]);
  });

  it("does nothing for a missing or empty list", async () => {
    await removeStoredFiles(undefined, WS);
    await removeStoredFiles([], WS);
    expect(removed.calls).toEqual([]);
  });

  it("removes in chunks of 100", async () => {
    const many = Array.from({ length: 230 }, (_, i) => `${WS}/d${i}/f.pdf`);
    await removeStoredFiles(many, WS);
    expect(removed.calls.map((c) => c.length)).toEqual([100, 100, 30]);
  });

  it("never throws, whether storage answers an error or the call itself fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.fail = true;
    await expect(removeStoredFiles([`${WS}/d1/a.pdf`], WS)).resolves.toBeUndefined();
    state.fail = false;
    state.throws = true;
    await expect(removeStoredFiles([`${WS}/d1/a.pdf`], WS)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
