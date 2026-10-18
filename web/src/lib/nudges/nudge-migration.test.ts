/** Migration 0096 - source-text drift test (no live Postgres in this suite). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "supabase", "migrations", "20261018000096_workspace_nudge_settings.sql"),
  "utf8",
)
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0096 workspace nudge settings", () => {
  it("adds the four workspace settings with the specified defaults, idempotently", () => {
    expect(sql).toMatch(/add column if not exists stale_days\s+int\s+not null default 14/);
    expect(sql).toMatch(/add column if not exists weekly_report_enabled\s+boolean\s+not null default true/);
    expect(sql).toMatch(/add column if not exists weekly_report_day\s+smallint\s+not null default 1/);
    expect(sql).toMatch(/add column if not exists nudges_enabled\s+boolean\s+not null default true/);
  });
  it("bounds stale_days to 1-365 and the weekday to 1-7", () => {
    expect(sql).toMatch(/check\s*\(stale_days between 1 and 365\)/);
    expect(sql).toMatch(/check\s*\(weekly_report_day between 1 and 7\)/);
  });
  it("creates nudge_log with one nudge per item per recipient per day", () => {
    expect(sql).toMatch(/create table if not exists nudge_log/);
    expect(sql).toMatch(/kind\s+text not null check \(kind in \('stale', 'weekly_report'\)\)/);
    expect(sql).toMatch(/create unique index if not exists nudge_log_once_per_day\s+on nudge_log \(workspace_id, kind, target_type, target_id, recipient_id, sent_on\)/);
  });
  it("stores one weekly report per workspace per week", () => {
    expect(sql).toMatch(/create table if not exists weekly_reports/);
    expect(sql).toMatch(/unique \(workspace_id, week_start\)/);
  });
  it("is select-only under RLS on both new tables (writes are service-role only)", () => {
    for (const t of ["nudge_log", "weekly_reports"]) {
      expect(sql).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`));
      expect(sql).toMatch(
        new RegExp(`create policy "read ${t}" on ${t}\\s+for select using \\(workspace_id = nopm_current_workspace\\(\\)\\)`),
      );
    }
    expect(sql).not.toMatch(/for (insert|update|delete|all)/i);
  });
  it("revokes browser writes on both tables (second layer, as 0048)", () => {
    expect(sql).toMatch(/revoke insert, update, delete on nudge_log\s+from anon, authenticated/);
    expect(sql).toMatch(/revoke insert, update, delete on weekly_reports\s+from anon, authenticated/);
  });
  it("is additive: no drop of a table or column, no truncate, no row delete, no backfill update", () => {
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate|delete\s+from|\bupdate\s+\w+\s+set/i);
  });
});
