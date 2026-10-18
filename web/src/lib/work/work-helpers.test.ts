import { describe, it, expect } from "vitest";
import { z } from "zod";
import { findUnknownFields, unknownFieldsMessage } from "./unknown-fields";
import { needsResolutionNote, rankIncreased, RESOLUTION_NOTE_MESSAGE } from "./resolution";
import { openTasksMessage } from "./milestone-open-tasks";
import { isManagerOrAdmin, principalRoleOf } from "./roles";
import type { Actor } from "@/lib/auth/guard";

const schema = z.object({ a: z.string().optional(), b: z.number().optional() });

describe("unknown fields (Q-WRK-18)", () => {
  it("lists only keys the schema does not know", () => {
    expect(findUnknownFields({ a: "x", c: 1, d: 2 }, schema)).toEqual(["c", "d"]);
    expect(findUnknownFields({ a: "x" }, schema)).toEqual([]);
    expect(findUnknownFields({ c: 1 }, schema, ["c"])).toEqual([]);
  });
  it("ignores bodies that are not objects (zod reports those)", () => {
    expect(findUnknownFields(null, schema)).toEqual([]);
    expect(findUnknownFields([1], schema)).toEqual([]);
    expect(findUnknownFields("x", schema)).toEqual([]);
  });
  it("uses the agreed wording", () => {
    expect(unknownFieldsMessage(["x"])).toBe('Unknown field "x". Nothing was saved.');
    expect(unknownFieldsMessage(["x", "y"])).toBe('Unknown fields "x", "y". Nothing was saved.');
  });
});

describe("resolution note and escalation (Q-WRK-19)", () => {
  it("blank notes do not count", () => {
    expect(needsResolutionNote(undefined)).toBe(true);
    expect(needsResolutionNote(null)).toBe(true);
    expect(needsResolutionNote("  ")).toBe(true);
    expect(needsResolutionNote("fixed")).toBe(false);
    expect(RESOLUTION_NOTE_MESSAGE).toBe("Add a short note on how this was resolved.");
  });
  it("rankIncreased compares low < medium < high < critical", () => {
    expect(rankIncreased("low", "medium")).toBe(true);
    expect(rankIncreased("high", "critical")).toBe(true);
    expect(rankIncreased("high", "high")).toBe(false);
    expect(rankIncreased("critical", "low")).toBe(false);
    expect(rankIncreased(undefined, "high")).toBe(false);
  });
});

describe("milestone warning (Q-WRK-14)", () => {
  it("matches the agreed message", () => {
    expect(openTasksMessage(3)).toBe("3 tasks are still open. Complete this milestone anyway?");
    expect(openTasksMessage(1)).toBe("1 task is still open. Complete this milestone anyway?");
  });
});

describe("roles", () => {
  const base = { id: "x", label: "x", workspaceId: "w" };
  it("a session is judged by its role, a token by its creator's current role", () => {
    expect(isManagerOrAdmin({ ...base, type: "user", role: "manager" } as Actor)).toBe(true);
    expect(isManagerOrAdmin({ ...base, type: "user", role: "member" } as Actor)).toBe(false);
    expect(isManagerOrAdmin({ ...base, type: "token", principalRole: "admin" } as Actor)).toBe(true);
    expect(isManagerOrAdmin({ ...base, type: "token", principalRole: null } as Actor)).toBe(false);
    expect(principalRoleOf({ ...base, type: "token" } as Actor)).toBeNull();
  });
});
