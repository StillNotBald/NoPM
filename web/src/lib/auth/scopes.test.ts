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

  it("accepts per-resource wildcards but not the bare global wildcard", () => {
    expect(isValidScope("*")).toBe(false); // bare global "*" is no longer mintable
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

  it("the assistant can request but never approve (no approve/admin scopes)", () => {
    const tool = new Set<string>(TOOL_SCOPES);
    // four-eyes: the AI can request a delete and raise a rebaseline, but cannot
    // approve a delete or sign off / apply a rebaseline.
    expect(tool.has("task:delete:request")).toBe(true);
    expect(tool.has("task:delete:approve")).toBe(false);
    expect(tool.has("rebaseline:approve")).toBe(false);
    // project deletion is also four-eyes (Decision 3, devops-wave1). The
    // assistant is now wired with request_project_deletion (devops-wave1b, U3)
    // — the maker side is on the ceiling, mirroring task:delete:request — but
    // approve must never appear, exactly like the task-deletion pair above.
    expect(tool.has("project:delete:request")).toBe(true);
    expect(tool.has("project:delete:approve")).toBe(false);
    // and no wildcard could smuggle an approve in
    expect(tool.has("*")).toBe(false);
    for (const s of TOOL_SCOPES) expect(s.endsWith(":*")).toBe(false);
  });
});
