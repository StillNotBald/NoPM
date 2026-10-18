/**
 * Migrations 0059 (auth_hardening) and 0060 (mfa_replay_guard) — source-text guards.
 * There is no Postgres in this suite, so these pin the SQL by reading it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const squash = (name: string) =>
  readFileSync(join(process.cwd(), "supabase", "migrations", name), "utf8")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

describe("0059 auth_hardening", () => {
  const sql = squash("20261017000059_auth_hardening.sql");

  it("nopm_rate_peek reads the counter without writing", () => {
    const body = sql.slice(sql.indexOf("create or replace function nopm_rate_peek"), sql.indexOf("nopm_auth_user_for_invite"));
    expect(body).toContain("returns jsonb");
    expect(body).toContain("stable");
    expect(body).toContain("from nopm_rate_counters");
    expect(body).not.toMatch(/\b(insert|update|delete)\b/);
    expect(body).toContain("floor(now_epoch / p_window_seconds) * p_window_seconds");
  });

  it("nopm_auth_user_for_invite is security definer with a pinned search_path", () => {
    expect(sql).toContain("create or replace function nopm_auth_user_for_invite");
    expect(sql).toMatch(/security definer set search_path = public, auth/);
  });

  it("both functions are service-role only", () => {
    for (const fn of ["nopm_rate_peek(text, int, int)", "nopm_auth_user_for_invite(text)"]) {
      expect(sql).toContain(`revoke execute on function ${fn} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${fn} to service_role`);
    }
  });

  it("changes no data and drops nothing", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\bdelete from\b|\bupdate \w+ set\b/);
  });
});

describe("0060 mfa_replay_guard", () => {
  const sql = squash("20261017000060_mfa_replay_guard.sql");

  it("adds one nullable bigint column, idempotently", () => {
    expect(sql).toContain("alter table user_mfa add column if not exists last_totp_step bigint");
    expect(sql).not.toContain("not null");
  });

  it("changes no data and drops nothing", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b|\bdelete from\b|\bupdate \w+ set\b/);
  });
});
