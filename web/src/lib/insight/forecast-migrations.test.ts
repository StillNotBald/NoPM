import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(resolve(dir, f), "utf8");

describe("migration 0097 forecast to complete + approver assignment", () => {
  const sql = read("20261018000097_budget_etc.sql");
  it("adds the forecast columns additively with a method check", () => {
    expect(sql).toMatch(/add column if not exists estimate_to_complete numeric\(14,2\)/);
    expect(sql).toMatch(/add column if not exists forecast_method text not null default 'cpi'/);
    expect(sql).toMatch(/check \(forecast_method in \('cpi', 'bottom_up'\)\) not valid/);
    expect(sql).toMatch(/estimate_to_complete is null or estimate_to_complete >= 0/);
  });
  it("adds a nullable assigned_approver_id (FK profiles, set null) to all three request tables", () => {
    for (const t of ["change_requests", "deletion_requests", "rebaselines"]) {
      expect(sql).toMatch(
        new RegExp(
          `alter table ${t}\\s+add column if not exists assigned_approver_id uuid references profiles\\(id\\) on delete set null`,
        ),
      );
      expect(sql).toMatch(new RegExp(`on ${t} \\(workspace_id, assigned_approver_id\\) where assigned_approver_id is not null`));
    }
  });
  it("adds committed_open (open commitments, nullable) and validates the checks in a skip-on-failure block", () => {
    expect(sql).toMatch(/add column if not exists committed_open numeric\(14,2\)/);
    expect(sql).toMatch(/committed_open is null or committed_open >= 0/);
    expect(sql).toMatch(/validate constraint project_budget_etc_nonneg_chk/);
    expect(sql).toMatch(/validate constraint project_budget_forecast_method_chk/);
    expect(sql).toMatch(/validate constraint project_budget_committed_open_nonneg_chk/);
    expect(sql).toMatch(/exception when others then/);
  });
  it("changes no existing data", () => {
    expect(sql).not.toMatch(/delete from|truncate|update \w+ set/i);
    expect(sql).not.toMatch(/\bdrop\s/i);
  });
});

describe("migration 0098 project snapshots", () => {
  const sql = read("20261018000098_project_snapshots.sql");
  it("creates the table with every snapshot column and one row per project per day", () => {
    for (const c of [
      "workspace_id",
      "project_id",
      "taken_at",
      "spi",
      "cpi",
      "eac",
      "planned_end",
      "forecast_end",
      "slip_days",
      "completion_pct",
      "open_risks_high",
      "rag_declared",
      "rag_suggested",
    ]) {
      expect(sql).toContain(c);
    }
    expect(sql).toMatch(/unique \(project_id, taken_at\)/);
    expect(sql).toMatch(/rag_suggested in \('green', 'amber', 'red'\)/);
  });
  it("is select-only under RLS and has no backfill", () => {
    expect(sql).toMatch(/enable row level security/);
    expect(sql).toMatch(/for select using \(workspace_id = nopm_current_workspace\(\)\)/);
    expect(sql).not.toMatch(/for (insert|update|delete|all)/i);
    expect(sql).toMatch(/revoke insert, update, delete on project_snapshots from anon, authenticated/);
    expect(sql).not.toMatch(/insert into|delete from|truncate/i);
  });
});

describe("vercel.json crons", () => {
  const cfg = JSON.parse(readFileSync(resolve(__dirname, "../../../vercel.json"), "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  it("keeps the daily integrations tick and adds the snapshot tick", () => {
    expect(cfg.crons).toContainEqual({ path: "/api/integrations/cron", schedule: "7 1 * * *" });
    expect(cfg.crons.map((c) => c.path)).toContain("/api/cron/snapshots");
  });
});
