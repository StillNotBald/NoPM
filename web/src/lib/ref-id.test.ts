/**
 * nextRefId tests — human-readable register IDs (R-001, ISS-042, CL-007).
 *
 * These IDs are what a PM quotes in a meeting, so the numbering rules are
 * pinned here: max-suffix + 1, zero-padded to 3, with a COUNT+1 fallback when
 * nothing parses. The Supabase client is a hand-rolled chainable stub — the
 * query shape (table, column, workspace filter) is asserted too, since a wrong
 * filter would silently number across workspaces.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nextRefId } from "./ref-id";

type Row = { reference_id: string | null };
type QueryResult = { data: Row[] | null; error: { message: string } | null };

/**
 * Mirrors `db.from(t).select(c).eq(k,v).not(c,op,v)` → awaited { data, error }.
 * The terminal `.not()` resolves; every call is recorded for assertions.
 */
function fakeDb(result: QueryResult) {
  const not = vi.fn(async () => result);
  const eq = vi.fn(() => ({ not }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { from, select, eq, not, client: { from } as unknown as SupabaseClient };
}

function rows(...ids: Array<string | null>): QueryResult {
  return { data: ids.map((reference_id) => ({ reference_id })), error: null };
}

const WS = "ws-11111111-1111-1111-1111-111111111111";

describe("nextRefId — first ID in an empty register", () => {
  it("returns PREFIX-001 when there are no rows", async () => {
    const db = fakeDb({ data: [], error: null });
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-001");
  });

  it("returns PREFIX-001 when the query returns null data", async () => {
    const db = fakeDb({ data: null, error: null });
    await expect(nextRefId(db.client, WS, "clashes", "CL")).resolves.toBe("CL-001");
  });
});

describe("nextRefId — incrementing from the maximum existing suffix", () => {
  it("uses the max suffix, not the row count or insertion order", async () => {
    const db = fakeDb(rows("R-001", "R-007", "R-003"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-008");
  });

  it("compares numerically, not lexicographically (R-9 vs R-10)", async () => {
    const db = fakeDb(rows("R-9", "R-10"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-011");
  });

  it("ignores a mismatched prefix and still takes the max suffix", async () => {
    // The query is not prefix-filtered, so any row in the table participates.
    const db = fakeDb(rows("R-002", "LEGACY-050"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-051");
  });

  it("uses the suffix after the LAST dash for multi-dash IDs", async () => {
    const db = fakeDb(rows("PROJ-A-014"));
    await expect(nextRefId(db.client, WS, "issues", "ISS")).resolves.toBe("ISS-015");
  });
});

describe("nextRefId — zero padding", () => {
  it("pads to three digits", async () => {
    const db = fakeDb(rows("R-041"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-042");
  });

  it("does not pad or truncate beyond three digits", async () => {
    const db = fakeDb(rows("ISS-999"));
    await expect(nextRefId(db.client, WS, "issues", "ISS")).resolves.toBe("ISS-1000");
  });
});

describe("nextRefId — resilience to unparseable suffixes", () => {
  it("skips a non-numeric suffix in favour of a parseable one", async () => {
    const db = fakeDb(rows("R-abc", "R-005", "R-xyz"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-006");
  });

  it("falls back to COUNT+1 when NO suffix parses (documented quirk: skips low numbers)", async () => {
    // Two unparseable rows → maxNum stays 0 → fallback = data.length = 2 → R-003.
    // R-001/R-002 are never issued even though nothing uses them.
    const db = fakeDb(rows("R-abc", "R-xyz"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-003");
  });

  it("skips IDs with no dash at all, then falls back to COUNT+1", async () => {
    const db = fakeDb(rows("R001"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-002");
  });

  it("skips null reference_id rows but still counts them in the fallback", async () => {
    const db = fakeDb(rows(null, null, null));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-004");
  });

  it("parses a leading-numeric suffix the way parseInt does (R-12abc → 12)", async () => {
    const db = fakeDb(rows("R-12abc"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-013");
  });

  it("treats an empty suffix as unparseable and falls back to COUNT+1", async () => {
    const db = fakeDb(rows("R-"));
    await expect(nextRefId(db.client, WS, "risks", "R")).resolves.toBe("R-002");
  });
});

describe("nextRefId — query shape and prefix handling", () => {
  it("queries the requested table, the reference_id column, and filters by workspace", async () => {
    const db = fakeDb(rows("ISS-001"));
    await nextRefId(db.client, WS, "issues", "ISS");

    expect(db.from).toHaveBeenCalledWith("issues");
    expect(db.select).toHaveBeenCalledWith("reference_id");
    expect(db.eq).toHaveBeenCalledWith("workspace_id", WS);
    expect(db.not).toHaveBeenCalledWith("reference_id", "is", null);
  });

  it.each([
    ["risks", "R", "R-002"],
    ["issues", "ISS", "ISS-002"],
    ["clashes", "CL", "CL-002"],
  ] as const)("applies the caller's prefix for %s", async (table, prefix, expected) => {
    const db = fakeDb(rows(`${prefix}-001`));
    await expect(nextRefId(db.client, WS, table, prefix)).resolves.toBe(expected);
  });
});

describe("nextRefId — read failure", () => {
  it("throws a contextual error naming the table (never returns a duplicate-prone ID)", async () => {
    const db = fakeDb({ data: null, error: { message: "connection reset" } });
    await expect(nextRefId(db.client, WS, "risks", "R")).rejects.toThrow(
      "nextRefId: failed to read risks: connection reset",
    );
  });
});
