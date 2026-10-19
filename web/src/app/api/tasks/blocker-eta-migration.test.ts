import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEDULE_SHAPE_TASK_FIELDS } from "@/lib/governance/lock";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261018000111_task_blocker_eta.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 0111 task blocker reason and ETA (R-166)", () => {
  it("adds both columns idempotently, nullable, with no default and no NOT NULL", () => {
    expect(code).toContain("alter table tasks add column if not exists blocker_reason text;");
    expect(code).toContain("alter table tasks add column if not exists eta date;");
    expect(code).not.toMatch(/column if not exists blocker_reason[^;]*(not null|default)/i);
    expect(code).not.toMatch(/column if not exists eta[^;]*(not null|default)/i);
  });

  it("caps the reason at 500 characters with a CHECK added NOT VALID, guarded for re-runs", () => {
    expect(code).toContain("tasks_blocker_reason_len");
    expect(code).toContain("char_length(blocker_reason) <= 500");
    expect(code).toContain("not valid");
    expect(code).toMatch(/if not exists \(\s*select 1 from pg_constraint/);
  });

  it("validates the constraint and RAISES (not NOTICE) when validation fails", () => {
    expect(code).toContain("validate constraint tasks_blocker_reason_len");
    expect(code).toMatch(/exception when others then\s+raise exception/);
    expect(code).not.toMatch(/raise notice/i);
  });

  it("does not backfill, rewrite or drop anything and states a rollback", () => {
    expect(code).not.toMatch(/\bupdate\s+tasks\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(sql).toMatch(/ROLLBACK/);
  });

  it("neither field is a schedule-shape field (both stay editable on a locked project, like blocked_by)", () => {
    expect(SCHEDULE_SHAPE_TASK_FIELDS as readonly string[]).not.toContain("eta");
    expect(SCHEDULE_SHAPE_TASK_FIELDS as readonly string[]).not.toContain("blocker_reason");
  });
});
