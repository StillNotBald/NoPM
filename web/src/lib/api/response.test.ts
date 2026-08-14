/**
 * JSON-contract tests for the response helpers.
 *
 * The constitution fixes exactly one envelope for every NoPM endpoint:
 *   success → { data }            (+ { total, page, limit } for lists)
 *   failure → { error }           (+ { fields } for validation)
 * Any drift here silently breaks every CLI/agent caller, so the shapes are
 * asserted key-for-key (not just "contains data") and the status codes are
 * pinned.
 */
import { describe, it, expect } from "vitest";
import { ok, okList, created, noContent, fail, validationError, safeJson } from "./response";

describe("ok", () => {
  it("wraps the payload in { data } with status 200", async () => {
    const res = ok({ id: "p1", name: "Proj One" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { id: "p1", name: "Proj One" } });
    expect(Object.keys(body)).toEqual(["data"]);
  });

  it("emits application/json", () => {
    expect(ok({}).headers.get("content-type")).toContain("application/json");
  });

  it("preserves primitives and null as the data value (no coercion to an object)", async () => {
    expect(await ok(null).json()).toEqual({ data: null });
    expect(await ok(42).json()).toEqual({ data: 42 });
    expect(await ok([1, 2]).json()).toEqual({ data: [1, 2] });
  });

  it("honours a ResponseInit override (e.g. a custom status)", async () => {
    const res = ok({ ok: true }, { status: 202 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});

describe("okList", () => {
  it("returns { data, total, page, limit } at the top level, status 200", async () => {
    const res = okList([{ id: "t1" }, { id: "t2" }], { total: 27, page: 2, limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [{ id: "t1" }, { id: "t2" }], total: 27, page: 2, limit: 10 });
    // meta is a sibling of data, never nested inside it
    expect(Object.keys(body).sort()).toEqual(["data", "limit", "page", "total"]);
  });

  it("keeps an empty page as an empty array with total 0 (not null)", async () => {
    const body = await okList([], { total: 0, page: 1, limit: 50 }).json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("created", () => {
  it("returns { data } with status 201", async () => {
    const res = created({ id: "new" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: "new" } });
  });
});

describe("noContent", () => {
  it("returns status 204 with a null body", async () => {
    const res = noContent();
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
  });
});

describe("fail", () => {
  it("returns { error } with status 500 by default", async () => {
    const res = fail("Something broke");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Something broke" });
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("honours an explicit status code", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const res = fail("nope", status);
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe("nope");
    }
  });

  it("merges extra keys as siblings of error", async () => {
    const res = fail("Rate limited", 429, { retry_after: 30 });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Rate limited", retry_after: 30 });
  });

  it("lets an extra key named 'error' override the message (spread order)", async () => {
    // Documented consequence of `{ error: message, ...extra }` — callers must
    // not pass an `error` key in extra unless they mean to replace the message.
    const body = await fail("original", 400, { error: "override" }).json();
    expect(body.error).toBe("override");
  });
});

describe("validationError", () => {
  it("returns { error, fields } with status 422", async () => {
    const res = validationError("Validation failed", [
      { field: "name", message: "name is required" },
      { field: "severity", message: "Invalid enum value" },
    ]);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: "Validation failed",
      fields: [
        { field: "name", message: "name is required" },
        { field: "severity", message: "Invalid enum value" },
      ],
    });
  });

  it("omits the fields key entirely when no field errors are given", async () => {
    const body = await validationError("Validation failed").json();
    expect(body).toEqual({ error: "Validation failed" });
    expect("fields" in body).toBe(false);
  });

  it("includes an explicitly empty fields array (only undefined omits it)", async () => {
    const body = await validationError("Validation failed", []).json();
    expect(body.fields).toEqual([]);
  });
});

describe("safeJson", () => {
  function jsonRequest(raw: string): Request {
    return new Request("http://localhost/api/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
  }

  it("parses a valid JSON body", async () => {
    await expect(safeJson(jsonRequest('{"name":"Task A","completion_pct":50}'))).resolves.toEqual({
      name: "Task A",
      completion_pct: 50,
    });
  });

  it("returns null for a malformed body instead of throwing", async () => {
    await expect(safeJson(jsonRequest("{not json"))).resolves.toBeNull();
  });

  it("returns null for an empty body", async () => {
    const req = new Request("http://localhost/api/x", { method: "POST" });
    await expect(safeJson(req)).resolves.toBeNull();
  });

  it("returns null when the underlying stream throws", async () => {
    const req = { json: async () => { throw new Error("stream closed"); } } as unknown as Request;
    await expect(safeJson(req)).resolves.toBeNull();
  });

  it("passes JSON primitives through (null body parses to null, same as a failure)", async () => {
    // Note: a literal `null` payload is indistinguishable from a parse failure.
    await expect(safeJson(jsonRequest("null"))).resolves.toBeNull();
    await expect(safeJson(jsonRequest("[]"))).resolves.toEqual([]);
  });
});
