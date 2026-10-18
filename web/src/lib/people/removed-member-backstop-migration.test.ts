import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20261017000087_removed_member_backstop.sql"),
  "utf8",
);

describe("migration 0087 removed-member backstop", () => {
  it("both RLS scope helpers require an active profile and keep security definer + search_path", () => {
    for (const fn of ["nopm_current_workspace", "nopm_current_role"]) {
      const body = sql.slice(sql.indexOf(`function ${fn}()`)).split("$$;")[0];
      expect(body).toContain("security definer set search_path = public");
      expect(body).toContain("from profiles where id = auth.uid() and status = 'active'");
    }
  });
  it("the session kill function is service-role only", () => {
    expect(sql).toContain("revoke all on function nopm_revoke_user_sessions(uuid) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function nopm_revoke_user_sessions(uuid) to service_role");
  });
});
