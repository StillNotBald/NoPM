import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { insertWithReference, nextReference } from "./next-ref";

const dbWith = (answers: Array<{ data: unknown; error: { message: string } | null }>) => {
  const rpc = vi.fn(async () => answers.shift() ?? { data: null, error: { message: "empty" } });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
};

describe("nextReference", () => {
  it("asks the counter function for the workspace and kind", async () => {
    const { db, rpc } = dbWith([{ data: "CR-008", error: null }]);
    await expect(nextReference(db, "ws", "change_request")).resolves.toBe("CR-008");
    expect(rpc).toHaveBeenCalledWith("nopm_next_ref", { p_workspace_id: "ws", p_kind: "change_request" });
  });
  it("fails closed on an rpc error or a non-string answer", async () => {
    await expect(nextReference(dbWith([{ data: null, error: { message: "boom" } }]).db, "ws", "decision")).rejects.toThrow("boom");
    await expect(nextReference(dbWith([{ data: { a: 1 }, error: null }]).db, "ws", "decision")).rejects.toThrow("unexpected");
  });
});

describe("insertWithReference", () => {
  it("retries a unique violation with the next number", async () => {
    const { db } = dbWith([
      { data: "DOC-003", error: null },
      { data: "DOC-004", error: null },
    ]);
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dup" } })
      .mockResolvedValueOnce({ data: { id: 1 }, error: null });
    const res = await insertWithReference(db, "ws", "document", insert);
    expect(res.data).toEqual({ id: 1 });
    expect(insert.mock.calls.map((c) => c[0])).toEqual(["DOC-003", "DOC-004"]);
  });
  it("does not retry other errors", async () => {
    const { db, rpc } = dbWith([{ data: "CR-001", error: null }]);
    const insert = vi.fn().mockResolvedValue({ data: null, error: { code: "23502", message: "null" } });
    const res = await insertWithReference(db, "ws", "change_request", insert);
    expect(res.error?.code).toBe("23502");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
