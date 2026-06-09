import { describe, it, expect } from "vitest";
import { SCOPES, isValidScope } from "./scopes";
import { TOOL_SCOPES } from "@/lib/assistant/tools";

describe("scope registry", () => {
  it("has no duplicate scopes", () => {
    expect(new Set(SCOPES).size).toBe(SCOPES.length);
  });

  it("accepts every concrete registered scope", () => {
    for (const s of SCOPES) expect(isValidScope(s)).toBe(true);
  });

  it("accepts the global and per-resource wildcards", () => {
    expect(isValidScope("*")).toBe(true);
    expect(isValidScope("task:*")).toBe(true);
    expect(isValidScope("project:*")).toBe(true);
    expect(isValidScope("document:*")).toBe(true);
  });

  it("rejects unknown resources and unknown actions", () => {
    expect(isValidScope("bogus:read")).toBe(false);
    expect(isValidScope("project:teleport")).toBe(false);
    expect(isValidScope("task:delete:teleport")).toBe(false);
    expect(isValidScope("bogus:*")).toBe(false);
    expect(isValidScope("")).toBe(false);
    expect(isValidScope("project")).toBe(false);
  });

  it("is case-sensitive (no smuggling via casing)", () => {
    expect(isValidScope("Project:Read")).toBe(false);
    expect(isValidScope("TASK:*")).toBe(false);
  });

  it("every assistant TOOL_SCOPE is a registered scope", () => {
    for (const s of TOOL_SCOPES) expect(isValidScope(s)).toBe(true);
  });

  it("the assistant scope set stays a strict subset of the registry", () => {
    const registry = new Set<string>(SCOPES);
    for (const s of TOOL_SCOPES) expect(registry.has(s)).toBe(true);
  });
});
