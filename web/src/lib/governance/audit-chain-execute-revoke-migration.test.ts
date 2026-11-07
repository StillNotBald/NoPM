import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20261107000121_audit_chain_execute_revoke.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 0121 audit-chain execute revoke", () => {
  it("revokes EXECUTE on the audit-chain trigger function from public, anon and authenticated", () => {
    expect(code).toContain("revoke execute on function nopm_audit_chain() from public, anon, authenticated;");
  });
  it("leaves the RLS scope helpers callable (policies run them as the querying role)", () => {
    expect(code).not.toMatch(/nopm_current_(workspace|role)/);
  });
});
