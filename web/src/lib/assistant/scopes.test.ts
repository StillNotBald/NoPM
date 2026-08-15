/**
 * Governance envelope tests for the assistant ephemeral token.
 *
 * Core invariant: the assistant can REQUEST destructive actions (maker) but
 * can NEVER APPROVE them (checker). This preserves four-eyes / maker-checker
 * even when the assistant holds a token with the full TOOL_SCOPES set.
 */
import { describe, it, expect } from "vitest";
import { TOOL_SCOPES } from "./tools";
import { hasScope } from "@/lib/auth/tokens";

// Cast to a mutable array so hasScope (which takes string[]) accepts it.
const scopes: string[] = [...TOOL_SCOPES];

// ---------------------------------------------------------------------------
// TOOL_SCOPES membership — inclusions
// ---------------------------------------------------------------------------
describe("TOOL_SCOPES — required scopes are present", () => {
  it("includes task:delete:request (maker side of maker-checker)", () => {
    expect(scopes).toContain("task:delete:request");
  });

  it("includes project:delete:request (maker side of maker-checker, PROJECTS four-eyes)", () => {
    expect(scopes).toContain("project:delete:request");
  });

  it("includes project:read", () => {
    expect(scopes).toContain("project:read");
  });

  it("includes project:write", () => {
    expect(scopes).toContain("project:write");
  });

  it("includes risk:read", () => {
    expect(scopes).toContain("risk:read");
  });

  it("includes risk:write", () => {
    expect(scopes).toContain("risk:write");
  });

  it("includes task:read", () => {
    expect(scopes).toContain("task:read");
  });

  it("includes task:write", () => {
    expect(scopes).toContain("task:write");
  });

  it("includes audit:read (assistant can query audit trail)", () => {
    expect(scopes).toContain("audit:read");
  });
});

// ---------------------------------------------------------------------------
// TOOL_SCOPES membership — critical exclusions (governance hard limits)
// ---------------------------------------------------------------------------
describe("TOOL_SCOPES — forbidden scopes are absent", () => {
  it("does NOT include task:delete:approve (checker role denied to assistant)", () => {
    expect(scopes).not.toContain("task:delete:approve");
  });

  it("does NOT include project:delete:approve (checker role denied to assistant — PROJECTS four-eyes)", () => {
    expect(scopes).not.toContain("project:delete:approve");
  });

  it("does NOT include time:approve (checker role denied to assistant — timesheet four-eyes, L-31)", () => {
    expect(scopes).not.toContain("time:approve");
  });

  it("does NOT include any token:* scope", () => {
    const tokenScopes = scopes.filter((s) => s.startsWith("token:"));
    expect(tokenScopes).toHaveLength(0);
  });

  it("does NOT include token:create", () => {
    expect(scopes).not.toContain("token:create");
  });

  it("does NOT include any mfa:* scope (no scope starts with 'mfa')", () => {
    const mfaScopes = scopes.filter((s) => s.startsWith("mfa"));
    expect(mfaScopes).toHaveLength(0);
  });

  it("does NOT include the admin wildcard '*'", () => {
    expect(scopes).not.toContain("*");
  });

  it("does NOT include any resource-level wildcard (e.g. 'task:*')", () => {
    const wildcards = scopes.filter((s) => s.endsWith(":*"));
    expect(wildcards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasScope with TOOL_SCOPES — maker-checker invariant
// ---------------------------------------------------------------------------
describe("hasScope(TOOL_SCOPES, ...) — maker-checker invariant", () => {
  it("returns true for task:delete:request (assistant may REQUEST)", () => {
    expect(hasScope(scopes, "task:delete:request")).toBe(true);
  });

  it("returns false for task:delete:approve (assistant may NOT APPROVE)", () => {
    expect(hasScope(scopes, "task:delete:approve")).toBe(false);
  });

  it("returns false for time:approve (assistant may NOT approve a timesheet — L-31)", () => {
    expect(hasScope(scopes, "time:approve")).toBe(false);
  });

  it("returns true for project:delete:request (assistant may REQUEST project deletion)", () => {
    expect(hasScope(scopes, "project:delete:request")).toBe(true);
  });

  it("returns false for project:delete:approve (assistant may NOT APPROVE project deletion)", () => {
    expect(hasScope(scopes, "project:delete:approve")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasScope with TOOL_SCOPES — token / privilege-escalation guard
// ---------------------------------------------------------------------------
describe("hasScope(TOOL_SCOPES, ...) — privilege-escalation guard", () => {
  it("returns false for token:create", () => {
    expect(hasScope(scopes, "token:create")).toBe(false);
  });

  it("returns false for token:read", () => {
    expect(hasScope(scopes, "token:read")).toBe(false);
  });

  it("returns false for token:delete", () => {
    expect(hasScope(scopes, "token:delete")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasScope with TOOL_SCOPES — spot-check operational read/write access
// ---------------------------------------------------------------------------
describe("hasScope(TOOL_SCOPES, ...) — operational access spot-checks", () => {
  it("returns true for project:read", () => {
    expect(hasScope(scopes, "project:read")).toBe(true);
  });

  it("returns true for project:write", () => {
    expect(hasScope(scopes, "project:write")).toBe(true);
  });

  it("returns true for risk:write", () => {
    expect(hasScope(scopes, "risk:write")).toBe(true);
  });

  it("returns true for milestone:read", () => {
    expect(hasScope(scopes, "milestone:read")).toBe(true);
  });

  it("returns true for milestone:write", () => {
    expect(hasScope(scopes, "milestone:write")).toBe(true);
  });

  it("returns true for budget:read", () => {
    expect(hasScope(scopes, "budget:read")).toBe(true);
  });

  it("returns true for clash:read", () => {
    expect(hasScope(scopes, "clash:read")).toBe(true);
  });

  it("returns true for resource:read", () => {
    expect(hasScope(scopes, "resource:read")).toBe(true);
  });

  it("returns true for audit:read", () => {
    expect(hasScope(scopes, "audit:read")).toBe(true);
  });
});
