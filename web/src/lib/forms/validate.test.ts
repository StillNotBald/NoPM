import { describe, it, expect } from "vitest";
import { requireText, requireUuid, validateFields } from "./validate";

describe("requireText", () => {
  it("passes non-empty strings", () => {
    expect(requireText("hello", "required")).toBeNull();
  });

  it("passes whitespace-only strings (matches z.string().min(1))", () => {
    expect(requireText("   ", "required")).toBeNull();
  });

  it("fails on empty string", () => {
    expect(requireText("", "required")).toBe("required");
  });
});

describe("requireUuid", () => {
  it("passes a valid v4-shaped uuid", () => {
    expect(requireUuid("123e4567-e89b-12d3-a456-426614174000", "bad uuid")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(requireUuid("123E4567-E89B-12D3-A456-426614174000", "bad uuid")).toBeNull();
  });

  it("fails on empty string", () => {
    expect(requireUuid("", "bad uuid")).toBe("bad uuid");
  });

  it("fails on a non-uuid string", () => {
    expect(requireUuid("not-a-uuid", "bad uuid")).toBe("bad uuid");
  });
});

describe("validateFields", () => {
  it("returns ok:true when every rule passes", () => {
    const result = validateFields([
      { key: "name", value: "Task name", message: "Task name is required" },
    ]);
    expect(result).toEqual({ ok: true });
  });

  it("collects one error per failing key", () => {
    const result = validateFields([
      { key: "project_id", value: "", message: "Project is required" },
      { key: "name", value: "", message: "Sprint name is required" },
      { key: "start_date", value: "2026-01-01", message: "Start date is required" },
      { key: "end_date", value: "", message: "End date is required" },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: {
        project_id: "Project is required",
        name: "Sprint name is required",
        end_date: "End date is required",
      },
    });
  });

  it("uses uuid kind when specified", () => {
    const result = validateFields([
      { key: "member_id", value: "nope", message: "Please select a team member", kind: "uuid" },
    ]);
    expect(result).toEqual({
      ok: false,
      errors: { member_id: "Please select a team member" },
    });
  });

  it("keeps the first error per key (mirrors zod's issue.path[0] loop)", () => {
    const result = validateFields([
      { key: "name", value: "", message: "first message" },
      { key: "name", value: "", message: "second message" },
    ]);
    expect(result).toEqual({ ok: false, errors: { name: "first message" } });
  });
});
