/** Migration 0105 - source-text drift test (no live Postgres in this suite). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "20261018000105_github_work_events.sql"),
  "utf8",
)
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0105 github work events", () => {
  it("adds github to the connector kind check and to the audit channel check", () => {
    expect(sql).toMatch(/drop constraint if exists integration_connectors_kind_check/);
    expect(sql).toMatch(/check \(kind in \('lark', 'github'\)\)/);
    expect(sql).toMatch(/channel in \('ui', 'api', 'cli', 'mcp', 'assistant', 'lark', 'github'\)/);
    expect(sql).toMatch(/not valid;\s*alter table audit_log validate constraint audit_channel_check/);
  });

  it("indexes tasks by (workspace_id, external_ref)", () => {
    expect(sql).toMatch(/create index if not exists tasks_workspace_external_ref_idx\s+on tasks \(workspace_id, external_ref\)/);
  });

  it("adds a validated work_event_rules default to workspaces", () => {
    expect(sql).toMatch(/create or replace function nopm_valid_work_event_rules\(r jsonb\)/);
    expect(sql).toMatch(/add column if not exists work_event_rules jsonb not null/);
    expect(sql).toMatch(/"pr_opened": "started", "pr_merged": "in_review"/);
    expect(sql).toMatch(/"deploy_success": "completed", "deploy_failure": null/);
    expect(sql).toMatch(/check \(nopm_valid_work_event_rules\(work_event_rules\)\)/);
    for (const kind of ["pr_opened", "pr_merged", "pr_closed", "deploy_success", "deploy_failure"]) expect(sql).toContain(`'${kind}'`);
    for (const target of ["unstarted", "started", "in_review", "completed", "canceled"]) expect(sql).toContain(`'${target}'`);
  });

  it("creates work_events with replay protection per delivery and reference", () => {
    expect(sql).toMatch(/create table if not exists work_events/);
    expect(sql).toMatch(/unique \(connector_id, external_event_id, ref\)/);
    expect(sql).toMatch(/workspace_id\s+uuid not null references workspaces\(id\) on delete cascade/);
    expect(sql).toMatch(/connector_id\s+uuid not null references integration_connectors\(id\) on delete cascade/);
    for (const reason of ["project_locked", "unknown_ref", "no_rule", "already_at_or_beyond", "conflict", "no_linked_pr"]) {
      expect(sql).toContain(`'${reason}'`);
    }
  });

  it("stores a body hash and allows the replay and truncated reasons", () => {
    expect(sql).toMatch(/body_hash\s+text/);
    expect(sql).toMatch(/'replay', 'truncated'/);
  });

  it("moves a task, checks the project lock and writes the audit row in one function", () => {
    expect(sql).toMatch(/create or replace function nopm_apply_task_status_from_event\(/);
    expect(sql).toMatch(/from tasks where id = p_task_id and workspace_id = p_workspace_id for update/);
    expect(sql).toMatch(/from projects\s+where id = v_before.project_id and workspace_id = p_workspace_id for share/);
    expect(sql).toMatch(/'work_event.skipped'/);
    expect(sql).toMatch(/'task.update'/);
    expect(sql).toMatch(/revoke execute on function nopm_apply_task_status_from_event\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant\s+execute on function nopm_apply_task_status_from_event\([^)]*\) to service_role/);
  });

  it("is select-only under RLS with writes revoked (0048 style)", () => {
    expect(sql).toMatch(/alter table work_events enable row level security/);
    expect(sql).toMatch(/revoke insert, update, delete on work_events from anon, authenticated/);
    expect(sql).toMatch(/create policy "read work_events" on work_events\s+for select using \(workspace_id = nopm_current_workspace\(\)\)/);
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
  });
});

describe("0105 status label safety", () => {
  it("never writes a null label into tasks.status", () => {
    expect(sql).toMatch(/case when p_set_label and p_status_label is not null then p_status_label else status end/);
  });
});

describe("0106 no work event completes a task (owner decision Q7)", () => {
  const raw = readFileSync(
    join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "20261018000106_tier_decisions.sql"),
    "utf8",
  )
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const section = raw.slice(raw.indexOf("with old as ("));
  const fn = section.slice(section.indexOf("create or replace function nopm_valid_work_event_rules"));

  it("rewrites every stored completed rule to null before the stricter check exists", () => {
    expect(section).toMatch(/case when e\.value = '"completed"'::jsonb then 'null'::jsonb else e\.value end/);
    expect(section.indexOf("update workspaces")).toBeLessThan(section.indexOf("create or replace function nopm_valid_work_event_rules"));
    expect(section).toContain("'work_event_rules.update'");
    // the audit row keeps the real pre-update rules (review C2-04)
    expect(section).toContain("jsonb_build_object('work_event_rules', before_rules)");
  });

  it("changes the column default so deploy_success is null", () => {
    expect(section).toMatch(/alter column work_event_rules set default/);
    expect(section).toMatch(/"deploy_success": null, "deploy_failure": null/);
    expect(section).not.toMatch(/"deploy_success": "completed"/);
  });

  it("replaces the check function and rejects completed", () => {
    expect(fn).toContain("'unstarted', 'started', 'in_review', 'canceled'");
    expect(fn).not.toContain("'completed'");
  });
});
