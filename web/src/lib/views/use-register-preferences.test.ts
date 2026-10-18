import { describe, it, expect } from "vitest";
import { patchConfigColumns, patchConfigGroupBy } from "./use-register-preferences";
import type { PreferencesConfig } from "@/app/api/me/preferences/_schema";

describe("patchConfigColumns — merges into config.columns[register] only", () => {
  it("sets columns for a register on an empty config", () => {
    expect(patchConfigColumns({}, "tasks", ["name", "status_type"])).toEqual({
      columns: { tasks: ["name", "status_type"] },
    });
  });

  it("does not disturb other registers' columns", () => {
    const config: PreferencesConfig = { columns: { risks: ["title", "severity"] } };
    expect(patchConfigColumns(config, "tasks", ["name"])).toEqual({
      columns: { risks: ["title", "severity"], tasks: ["name"] },
    });
  });

  it("does not disturb sibling keys (density, groupBy, defaultLanding)", () => {
    const config: PreferencesConfig = { density: "compact", groupBy: { tasks: "priority" } };
    expect(patchConfigColumns(config, "tasks", ["name"])).toEqual({
      density: "compact",
      groupBy: { tasks: "priority" },
      columns: { tasks: ["name"] },
    });
  });

  it("overwrites a register's previous column selection, not appends", () => {
    const config: PreferencesConfig = { columns: { tasks: ["name"] } };
    expect(patchConfigColumns(config, "tasks", ["name", "priority"])).toEqual({
      columns: { tasks: ["name", "priority"] },
    });
  });
});

describe("patchConfigGroupBy — merges into config.groupBy[register] only", () => {
  it("sets groupBy for a register on an empty config", () => {
    expect(patchConfigGroupBy({}, "tasks", "priority")).toEqual({ groupBy: { tasks: "priority" } });
  });

  it("accepts null (explicit ungrouped)", () => {
    const config: PreferencesConfig = { groupBy: { tasks: "priority" } };
    expect(patchConfigGroupBy(config, "tasks", null)).toEqual({ groupBy: { tasks: null } });
  });

  it("does not disturb other registers' groupBy", () => {
    const config: PreferencesConfig = { groupBy: { risks: "severity" } };
    expect(patchConfigGroupBy(config, "tasks", "priority")).toEqual({
      groupBy: { risks: "severity", tasks: "priority" },
    });
  });

  it("does not disturb sibling keys (columns, density, defaultLanding)", () => {
    const config: PreferencesConfig = { columns: { tasks: ["name"] }, defaultLanding: "/dashboard" };
    expect(patchConfigGroupBy(config, "tasks", "priority")).toEqual({
      columns: { tasks: ["name"] },
      defaultLanding: "/dashboard",
      groupBy: { tasks: "priority" },
    });
  });
});
