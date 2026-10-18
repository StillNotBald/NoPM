import { describe, it, expect } from "vitest";
import {
  configFromSearchParams,
  searchParamsFromConfig,
  decodeStoredConfig,
  encodeConfigForStorage,
  emptyConfig,
  parseSort,
  buildSortParam,
  type SavedViewConfig,
} from "./view-config";

describe("view-config codec — URL state <-> config jsonb round trip", () => {
  it("empty search params decode to emptyConfig()", () => {
    expect(configFromSearchParams(new URLSearchParams())).toEqual(emptyConfig());
  });

  it("round-trips filters + sort + columns + groupBy through the URL", () => {
    const sp = new URLSearchParams();
    sp.set("status_type", "started");
    sp.set("priority", "high");
    sp.set("sort", "due_date:asc");
    sp.set("columns", "name,status_type,due_date");
    sp.set("groupBy", "assignee");

    const config = configFromSearchParams(sp);
    expect(config).toEqual({
      filters: { status_type: "started", priority: "high" },
      sort: { field: "due_date", direction: "asc" },
      columns: ["name", "status_type", "due_date"],
      groupBy: "assignee",
    });

    // config -> URLSearchParams -> config is stable (order-independent).
    const roundTripped = configFromSearchParams(searchParamsFromConfig(config));
    expect(roundTripped).toEqual(config);
  });

  it("ignores reserved control keys (page/limit/view) as filters", () => {
    const sp = new URLSearchParams({ page: "3", limit: "50", view: "abc-123", q: "urgent" });
    expect(configFromSearchParams(sp)).toEqual({
      filters: { q: "urgent" },
      sort: null,
      columns: null,
      groupBy: null,
    });
  });

  it("drops empty-string filter values", () => {
    const sp = new URLSearchParams({ q: "", status_type: "started" });
    expect(configFromSearchParams(sp).filters).toEqual({ status_type: "started" });
  });

  it("malformed sort param decodes to null, not a throw", () => {
    expect(parseSort("garbage")).toBeNull();
    expect(parseSort("field:sideways")).toBeNull();
    expect(parseSort(null)).toBeNull();
    expect(parseSort(undefined)).toBeNull();
    expect(buildSortParam(null)).toBeNull();
  });

  it("searchParamsFromConfig omits sort/columns/groupBy when unset", () => {
    const config: SavedViewConfig = {
      filters: { q: "x" },
      sort: null,
      columns: null,
      groupBy: null,
    };
    const sp = searchParamsFromConfig(config);
    expect(sp.has("sort")).toBe(false);
    expect(sp.has("columns")).toBe(false);
    expect(sp.has("groupBy")).toBe(false);
    expect(sp.get("q")).toBe("x");
  });
});

describe("decodeStoredConfig — defensive decode of a jsonb value from the DB", () => {
  it("round-trips a well-formed config through JSON serialise/parse", () => {
    const config: SavedViewConfig = {
      filters: { project_id: "11111111-2222-4333-8444-555555555555" },
      sort: { field: "priority", direction: "desc" },
      columns: ["name", "priority"],
      groupBy: "status_type",
    };
    const roundTripped = decodeStoredConfig(
      JSON.parse(JSON.stringify(encodeConfigForStorage(config))),
    );
    expect(roundTripped).toEqual(config);
  });

  it("falls back to emptyConfig() for null/non-object/corrupt shapes, never throws", () => {
    expect(decodeStoredConfig(null)).toEqual(emptyConfig());
    expect(decodeStoredConfig(undefined)).toEqual(emptyConfig());
    expect(decodeStoredConfig("a string")).toEqual(emptyConfig());
    expect(decodeStoredConfig(42)).toEqual(emptyConfig());
    expect(decodeStoredConfig({})).toEqual(emptyConfig());
    expect(() => decodeStoredConfig({ filters: "not-an-object" })).not.toThrow();
  });

  it("degrades field-by-field: a corrupt sort doesn't blank valid filters", () => {
    const decoded = decodeStoredConfig({
      filters: { q: "keep me" },
      sort: { field: "x" }, // missing direction — corrupt
      columns: ["ok"],
      groupBy: 42, // wrong type — corrupt
    });
    expect(decoded).toEqual({
      filters: { q: "keep me" },
      sort: null,
      columns: ["ok"],
      groupBy: null,
    });
  });

  it("an empty columns array decodes to null (not an empty array — 'no columns' is invalid)", () => {
    expect(decodeStoredConfig({ columns: [] }).columns).toBeNull();
  });

  it("rejects a columns array with non-string entries", () => {
    expect(decodeStoredConfig({ columns: ["ok", 5] }).columns).toBeNull();
  });
});
