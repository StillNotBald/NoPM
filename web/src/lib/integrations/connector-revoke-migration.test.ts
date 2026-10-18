/**
 * Migration 0069 (connector revoke is one transaction) - source-text drift test.
 * No live Postgres in this suite, so the file is read off disk and the contract
 * the route relies on is asserted (same approach as the other *-migration tests).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const FILE = "20261017000069_connector_revoke_atomic.sql";
const text = readFileSync(join(migrationsDir, FILE), "utf8");
const sql = text
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("0069 nopm_revoke_connector", () => {
  it("sorts after 0058", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf("20261017000058_unlock_voids_rebaselines.sql"));
  });

  it("does the whole revoke in one function: connector, identities, deliveries, link codes and ONE audit row", () => {
    expect(sql).toMatch(/create or replace function nopm_revoke_connector\(/);
    expect(sql).toMatch(/update integration_connectors\s+set status = 'revoked'/);
    expect(sql).toMatch(/update external_identities\s+set revoked_at/);
    expect(sql).toMatch(/update integration_deliveries\s+set status = 'superseded'/);
    expect(sql).toMatch(/delete from identity_link_codes/);
    expect(sql.match(/insert into audit_log/g)).toHaveLength(1);
    expect(sql).toContain("'integration.connector.revoke'");
  });

  it("every write is scoped to the workspace", () => {
    for (const table of ["integration_connectors", "external_identities", "integration_deliveries", "identity_link_codes"]) {
      const at = sql.search(new RegExp(`(update|delete from) ${table}`));
      expect(at, table).toBeGreaterThan(-1);
      expect(sql.slice(at, at + 400), table).toContain("workspace_id = p_workspace_id");
    }
  });

  it("locks the row first and refuses a missing or already-revoked connector", () => {
    expect(sql).toMatch(/for update/);
    expect(sql).toContain("CONNECTOR_NOT_FOUND");
    expect(sql).toContain("CONNECTOR_REVOKED");
  });

  it("carries channel and request_id provenance on the audit row", () => {
    const m = sql.match(/insert into audit_log \(([^)]*)\)/);
    expect(m?.[1]).toContain("channel");
    expect(m?.[1]).toContain("request_id");
  });

  it("pins search_path and is service-role only", () => {
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).toMatch(/revoke execute on function nopm_revoke_connector\([^)]*\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant\s+execute on function nopm_revoke_connector\([^)]*\) to service_role/);
  });

  it("is idempotent to apply (create or replace) and changes no existing data", () => {
    expect(sql).not.toMatch(/drop table|truncate|alter table/i);
  });
});
