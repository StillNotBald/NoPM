import { describe, it, expect } from "vitest";
import { parsePage, pageWindow, DECIDED_PAGE_SIZE } from "./_paging";

describe("parsePage", () => {
  it("defaults to 1 for absent / malformed / non-positive values", () => {
    for (const v of [undefined, "", "abc", "0", "-3", "1.5", "99999999"]) expect(parsePage(v)).toBe(1);
  });
  it("parses a positive integer", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("7")).toBe(7);
  });
});

describe("pageWindow", () => {
  it("gives the first page's inclusive range", () => {
    expect(pageWindow(1, 120)).toEqual({ page: 1, lastPage: 3, from: 0, to: DECIDED_PAGE_SIZE - 1 });
  });
  it("clamps a page past the end to the last page", () => {
    expect(pageWindow(9, 120)).toEqual({ page: 3, lastPage: 3, from: 100, to: 149 });
  });
  it("has one (empty) page when there are no rows", () => {
    expect(pageWindow(4, 0)).toEqual({ page: 1, lastPage: 1, from: 0, to: 49 });
  });
});
