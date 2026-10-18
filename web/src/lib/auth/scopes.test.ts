import { describe, it, expect } from "vitest";
import { SCOPES, PRIVILEGED_SCOPES, isValidScope, AGENT_PRESET_SCOPES, scopeChoices } from "./scopes";
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

  // D2 (2026-10-16): the five checker verbs are never reachable through a
  // wildcard (hasScope) — and no preset the product hands out carries one.
  describe("PRIVILEGED_SCOPES", () => {
    it("is a duplicate-free subset of the registry and exactly the approve/decide verbs", () => {
      expect(new Set(PRIVILEGED_SCOPES).size).toBe(PRIVILEGED_SCOPES.length);
      const registry = new Set<string>(SCOPES);
      for (const s of PRIVILEGED_SCOPES) {
        expect(registry.has(s)).toBe(true);
        expect(s).toMatch(/(:approve|:decide)$/);
      }
      // every registry scope that ends in :approve / :decide is covered — a new
      // checker scope added to SCOPES without being listed would be wildcard-grantable.
      const checkerVerbs = SCOPES.filter((s) => /(:approve|:decide)$/.test(s));
      expect([...PRIVILEGED_SCOPES].sort()).toEqual([...checkerVerbs].sort());
    });

    it("neither the assistant's tool scopes nor the agent preset carry a privileged scope", () => {
      const privileged = new Set<string>(PRIVILEGED_SCOPES);
      for (const s of TOOL_SCOPES) expect(privileged.has(s), `TOOL_SCOPES has ${s}`).toBe(false);
      for (const s of AGENT_PRESET_SCOPES) expect(privileged.has(s), `AGENT_PRESET_SCOPES has ${s}`).toBe(false);
    });
  });

  // F1e / L-49 — "Connect your agent" mints a PAT preset with this scope
  // list. It must stay read-only + task:write and never smuggle in an
  // approve/admin/token-management scope, however SCOPES grows later.
  describe("AGENT_PRESET_SCOPES (connect-your-agent preset)", () => {
    it("has no duplicates and is a strict subset of the registry", () => {
      expect(new Set(AGENT_PRESET_SCOPES).size).toBe(AGENT_PRESET_SCOPES.length);
      const registry = new Set<string>(SCOPES);
      for (const s of AGENT_PRESET_SCOPES) expect(registry.has(s)).toBe(true);
      for (const s of AGENT_PRESET_SCOPES) expect(isValidScope(s)).toBe(true);
    });

    it("is read-only plus exactly task:write — never approve/admin/token/delete", () => {
      const preset = new Set<string>(AGENT_PRESET_SCOPES);
      // the one write scope allowed
      expect(preset.has("task:write")).toBe(true);
      for (const s of AGENT_PRESET_SCOPES) {
        expect(s === "task:write" || s.endsWith(":read")).toBe(true);
      }
      // never a delete/approve step, never a bare/resource wildcard, never
      // an admin- or token-management scope (no such scope exists in the
      // registry today, but assert defensively so a future addition can't
      // silently widen this preset).
      for (const s of AGENT_PRESET_SCOPES) {
        expect(s).not.toMatch(/approve/);
        expect(s).not.toMatch(/admin/);
        expect(s).not.toMatch(/token/);
        expect(s).not.toMatch(/delete/);
        expect(s.endsWith(":*")).toBe(false);
      }
      expect(preset.has("*")).toBe(false);
      expect(preset.has("rebaseline:approve")).toBe(false);
      expect(preset.has("task:delete:approve")).toBe(false);
      expect(preset.has("task:delete:request")).toBe(false);
      expect(preset.has("project:delete:approve")).toBe(false);
      expect(preset.has("project:delete:request")).toBe(false);
      // Retired time:* scopes (hour logging removed) are never granted.
      expect(preset.has("time:read")).toBe(false);
      expect(preset.has("time:approve")).toBe(false);
      // R-83: change:decide is a decision-only (checker) scope, split from
      // change:write — the agent preset must never carry it. It's not a
      // :read scope so the derived filter already excludes it; assert
      // explicitly so the exclusion is locked, not incidental.
      expect(preset.has("change:decide")).toBe(false);
    });

    it("covers every readable resource in the registry", () => {
      const presetResources = new Set(
        AGENT_PRESET_SCOPES.filter((s) => s.endsWith(":read")).map((s) => s.split(":")[0]),
      );
      const readResources = new Set(
        SCOPES.filter((s) => s.endsWith(":read")).map((s) => s.split(":")[0]),
      );
      expect(presetResources).toEqual(readResources);
    });
  });

  // The token-mint UI's checkbox list (tokens/page.tsx) is DERIVED from
  // SCOPES via scopeChoices() rather than a second hand-curated list — these
  // tests are the one place that would catch a future registry addition
  // silently failing to show up as a mintable choice.
  describe("scopeChoices (tokens page checkbox list)", () => {
    it("covers every registered scope, directly or via its resource wildcard", () => {
      const choices = new Set(scopeChoices());
      for (const s of SCOPES) {
        const resource = s.split(":")[0];
        expect(choices.has(s) || choices.has(`${resource}:*`)).toBe(true);
      }
    });

    it("offers a wildcard only for a resource with more than one scope", () => {
      const choices = new Set(scopeChoices());
      const counts = new Map<string, number>();
      for (const s of SCOPES) {
        const resource = s.split(":")[0];
        counts.set(resource, (counts.get(resource) ?? 0) + 1);
      }
      for (const [resource, count] of counts) {
        expect(choices.has(`${resource}:*`)).toBe(count > 1);
      }
    });

    it("has no duplicate choices", () => {
      const choices = scopeChoices();
      expect(new Set(choices).size).toBe(choices.length);
    });

    it("every choice is itself a valid, mintable scope", () => {
      for (const c of scopeChoices()) expect(isValidScope(c)).toBe(true);
    });

    it("offers every privileged (approve/decide) scope as an EXPLICIT choice — wildcards no longer grant them (D2)", () => {
      const choices = new Set(scopeChoices());
      for (const s of PRIVILEGED_SCOPES) expect(choices.has(s), s).toBe(true);
    });

    it("keeps task:delete:request/approve and project:delete:request/approve as explicit entries", () => {
      const choices = new Set(scopeChoices());
      expect(choices.has("task:delete:request")).toBe(true);
      expect(choices.has("task:delete:approve")).toBe(true);
      expect(choices.has("project:delete:request")).toBe(true);
      expect(choices.has("project:delete:approve")).toBe(true);
    });
  });
});

describe("retired time:* scopes (hour logging removed)", () => {
  it("can no longer be minted, but a legacy token carrying them is inert, not broken", async () => {
    const { hasScope } = await import("@/lib/auth/tokens");
    for (const s of ["time:read", "time:write", "time:submit", "time:approve", "time:*"]) {
      expect(isValidScope(s)).toBe(false);
    }
    expect(scopeChoices().some((c) => c.startsWith("time:"))).toBe(false);
    expect(hasScope(["time:read", "time:approve", "task:read"], "task:read")).toBe(true);
    expect(hasScope(["time:read", "time:approve"], "task:read")).toBe(false);
  });
});
