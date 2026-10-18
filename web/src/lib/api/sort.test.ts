/**
 * The sort whitelist is a security control: it is the only thing standing
 * between a user-supplied `sort=` param and an arbitrary-column `.order()`.
 * (Adversarial-verify follow-up — this file was referenced by the F1 wave's
 * code but never written by it.)
 */
import { describe, it, expect } from "vitest";
import { parseSort, orderOptions, applySort } from "./sort";
import { RuleError } from "@/lib/api/errors";

const WHITELIST = ["due_date", "name", "created_at"] as const;
const FALLBACK = { field: "created_at", ascending: false };

describe("parseSort — whitelist enforcement", () => {
  it("returns the fallback when the param is missing or empty", () => {
    expect(parseSort(null, WHITELIST, FALLBACK)).toEqual(FALLBACK);
    expect(parseSort(undefined, WHITELIST, FALLBACK)).toEqual(FALLBACK);
    expect(parseSort("", WHITELIST, FALLBACK)).toEqual(FALLBACK);
  });

  it("parses whitelisted field:direction pairs", () => {
    expect(parseSort("due_date:asc", WHITELIST, FALLBACK)).toEqual({
      field: "due_date",
      ascending: true,
    });
    expect(parseSort("name:desc", WHITELIST, FALLBACK)).toEqual({
      field: "name",
      ascending: false,
    });
  });

  it.each([
    "token_hash:asc", // sensitive column
    "workspace_id:desc", // isolation column
    "id;drop table tasks:asc", // junk
    "unknown:asc",
  ])("throws RuleError (422) for a non-whitelisted field %j — never silently falls back", (raw) => {
    expect(() => parseSort(raw, WHITELIST, FALLBACK)).toThrowError(RuleError);
  });

  it("throws RuleError for a bad or missing direction", () => {
    expect(() => parseSort("name:upwards", WHITELIST, FALLBACK)).toThrowError(RuleError);
    expect(() => parseSort("name", WHITELIST, FALLBACK)).toThrowError(RuleError);
    expect(() => parseSort("name:", WHITELIST, FALLBACK)).toThrowError(RuleError);
  });
});

describe("orderOptions / applySort — nulls always last", () => {
  it("nullsFirst is false in BOTH directions", () => {
    expect(orderOptions({ field: "due_date", ascending: true })).toEqual({
      ascending: true,
      nullsFirst: false,
    });
    expect(orderOptions({ field: "due_date", ascending: false })).toEqual({
      ascending: false,
      nullsFirst: false,
    });
  });

  it("applySort calls .order with the parsed field and options", () => {
    const calls: unknown[] = [];
    const chain = {
      order(field: string, opts: { ascending: boolean; nullsFirst: boolean }) {
        calls.push([field, opts]);
        return chain;
      },
    };
    applySort(chain, { field: "name", ascending: true });
    expect(calls).toEqual([["name", { ascending: true, nullsFirst: false }]]);
  });
});
