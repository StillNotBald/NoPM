/** Migration-text test for 0099 (project dependencies, R-147). Read-only SQL scan. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const m = strip(readFileSync(join(dir, "20261018000099_project_dependencies.sql"), "utf8"));
const flat = m.replace(/\s+/g, " ");

describe("0099 project dependencies", () => {
  it("creates the table with the agreed columns and foreign keys", () => {
    expect(m).toMatch(/create table if not exists project_dependencies/);
    expect(m).toMatch(/workspace_id\s+uuid not null references workspaces\(id\) on delete cascade/);
    expect(m).toMatch(/project_id\s+uuid not null references projects\(id\) on delete cascade/);
    expect(m).toMatch(/depends_on_project_id\s+uuid not null references projects\(id\) on delete cascade/);
    expect(m).toMatch(/linked_risk_id\s+uuid references risks\(id\) on delete set null/);
    for (const col of ["note", "created_by", "created_at", "updated_at"]) expect(m).toContain(col);
  });

  it("checks the kind, forbids a self edge and keeps one row per (project, depends_on, kind)", () => {
    expect(m).toMatch(/kind in \('delivery', 'resource', 'decision', 'risk'\)/);
    expect(m).toMatch(/check \(project_id <> depends_on_project_id\)/);
    expect(m).toMatch(/unique \(project_id, depends_on_project_id, kind\)/);
  });

  it("refuses a dependency across workspaces (also for the linked risk) with CROSS_WORKSPACE", () => {
    expect(m).toMatch(/create or replace function nopm_project_dependency_same_workspace/);
    expect(m).toMatch(/raise exception 'CROSS_WORKSPACE'/);
    expect(m).toMatch(/p\.workspace_id = new\.workspace_id/);
    expect(m).toMatch(/r\.workspace_id = new\.workspace_id/);
    expect(m).toMatch(
      /create trigger trg_project_dependencies_workspace\s+before insert or update of workspace_id, project_id, depends_on_project_id, linked_risk_id/,
    );
  });

  it("refuses a loop with DEPENDENCY_CYCLE using a terminating recursive walk and a per-workspace lock", () => {
    expect(m).toMatch(/create or replace function nopm_project_dependency_cycle_guard/);
    expect(m).toMatch(/with recursive reach/);
    expect(m).toMatch(/\bunion\b(?!\s+all)/i);
    expect(m).toMatch(/pg_advisory_xact_lock/);
    expect(m).toMatch(/d\.id is distinct from new\.id/);
    expect(m).toMatch(/raise exception 'DEPENDENCY_CYCLE'/);
    expect(m).toMatch(
      /create trigger trg_project_dependencies_cycle\s+before insert or update of project_id, depends_on_project_id/,
    );
  });

  it("keeps updated_at current with the shared trigger function", () => {
    expect(m).toMatch(
      /create trigger trg_project_dependencies_updated\s+before update on project_dependencies\s+for each row execute function nopm_set_updated_at\(\)/,
    );
  });

  it("is select-only for browser roles: RLS on, one read policy, write privileges revoked", () => {
    expect(m).toMatch(/alter table project_dependencies enable row level security/);
    expect(m).toMatch(
      /create policy "read_project_dependencies" on project_dependencies\s+for select using \(workspace_id = nopm_current_workspace\(\)\)/,
    );
    expect(m).not.toMatch(/create policy[^;]*\bfor (all|insert|update|delete)\b/i);
    expect(m).toMatch(/revoke insert, update, delete on project_dependencies from anon, authenticated/);
  });

  it("locks the trigger functions away from browser roles", () => {
    for (const fn of ["nopm_project_dependency_same_workspace", "nopm_project_dependency_cycle_guard"]) {
      expect(m).toContain(`revoke execute on function ${fn}() from public, anon, authenticated`);
      expect(m).toContain(`grant  execute on function ${fn}() to service_role`);
    }
  });

  it("creates no dependency rows, drops nothing and leaves no trigger disabled", () => {
    expect(m).not.toMatch(/\binsert into\b|\bdelete from\b/i);
    expect(m).not.toMatch(/drop (table|column)|\btruncate\b|disable trigger/i);
    // the only UPDATE is the deletion-request re-snapshot checked below
    expect([...flat.matchAll(/\bupdate (\w+) (?:dr )?set\b/gi)].map((x) => x[1])).toEqual(["deletion_requests"]);
  });

  it("makes the project-deletion scope guard count project_dependencies (and exempt derived snapshots), from either side for dependencies", () => {
    expect(flat).toContain("create or replace function nopm_project_child_counts(p_project_id uuid)");
    expect(flat).toContain(
      "'project_dependencies', (select count(*) from project_dependencies where project_id = p_project_id or depends_on_project_id = p_project_id)",
    );
    expect(flat).not.toContain("project_snapshots where"); // derived nightly data stays out of the fingerprint
    // the content fingerprint covers them too, or a swapped dependency would go unnoticed
    expect(flat).toContain(
      "'project_dependencies', (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from project_dependencies where project_id = p_project_id or depends_on_project_id = p_project_id)",
    );
    // project_snapshots cascades too but is derived nightly data: deliberately outside the fingerprint
    expect(flat).not.toContain("from project_snapshots");
    expect(flat).toContain("revoke execute on function nopm_project_child_counts(uuid) from public, anon, authenticated");
    expect(flat).toContain("grant execute on function nopm_project_child_counts(uuid) to service_role");
  });

  it("re-snapshots pending project deletion requests so none is refused as CHILDREN_CHANGED by this migration", () => {
    expect(flat).toContain(
      "update deletion_requests dr set before = coalesce(dr.before, '{}'::jsonb) || jsonb_build_object('child_counts', nopm_project_child_counts(dr.target_id)) where dr.target_type = 'project' and dr.status = 'pending';",
    );
  });
});
