/**
 * Migration 0066 — the task roll-up must not bump projects.updated_at
 * (D-WRK-13). Source-text drift test, same approach as the other migration tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "20261017000066_project_rollup_keeps_updated_at.sql";
const text = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", FILE), "utf8");
const sql = text
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("migration 0066 project roll-up keeps updated_at", () => {
  it("defines a projects-specific updated_at function with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function nopm_projects_set_updated_at\(\)/);
    expect(sql).toMatch(/set search_path = public, pg_temp/);
  });

  it("keeps the old updated_at when only completion_pct changed", () => {
    expect(sql).toMatch(/- 'completion_pct' - 'updated_at'/);
    expect(sql).toMatch(/new\.updated_at := old\.updated_at/);
    expect(sql).toMatch(/new\.updated_at := now\(\)/);
  });

  it("re-points trg_projects_updated idempotently and does not touch other tables", () => {
    expect(sql).toMatch(/drop trigger if exists trg_projects_updated on projects/);
    expect(sql).toMatch(/create trigger trg_projects_updated before update on projects/);
    expect(sql).not.toMatch(/nopm_set_updated_at/);
  });
});
