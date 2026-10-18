/**
 * nopm_rate_check (migration 0050 section 3) — source-text guard.
 *
 * There is no Postgres in this suite, so this pins the SQL by reading it. The
 * behaviour itself (cap admitted exactly once per window; bounded prune; key and
 * window guards) was exercised against a local stack inside rolled-back
 * transactions: 700 calls against a cap of 300 admitted 600 under the 0029
 * function and exactly 300 under this one.
 *
 * The bug: 0029 built the window start as
 *   date_trunc('second', now()) - (extract(epoch from now())::int % W) * '1 s'
 * `date_trunc` FLOORS to the second but `::int` ROUNDS to the nearest, so in the
 * second half of every second the start came out one second early. Each window
 * was split over two bucket rows with separate counters, and a cap of N admitted
 * up to 2N requests per interval.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const squash = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();

/** The body of the LAST `create or replace function nopm_rate_check` across all migrations. */
function finalDefinition(): { file: string; sql: string } {
  let last: { file: string; sql: string } | null = null;
  for (const file of files) {
    const sql = squash(readFileSync(join(dir, file), "utf8"));
    const m = sql.match(/create or replace function nopm_rate_check[\s\S]*?\$\$;/);
    if (m) last = { file, sql: m[0] };
  }
  if (!last) throw new Error("nopm_rate_check is not defined by any migration");
  return last;
}

const guardSql = () => squash(readFileSync(join(dir, "20261017000050_truncate_guard.sql"), "utf8"));

describe("nopm_rate_check — the original bug is visible to this reader (canary)", () => {
  const original = squash(readFileSync(join(dir, "20260814000029_rate_limiting.sql"), "utf8"));

  it("0029 mixes a flooring date_trunc with a rounding ::int cast", () => {
    expect(original).toContain("date_trunc('second', now())");
    expect(original).toMatch(/extract\(epoch from now\(\)\)::int % p_window_seconds/);
  });
});

describe("nopm_rate_check — final definition", () => {
  const { file, sql } = finalDefinition();

  it("is defined by the 0050 migration (the last one to touch it)", () => {
    expect(file).toBe("20261017000050_truncate_guard.sql");
  });

  it("derives the window start and retry_after from ONE floor expression, with no date_trunc or ::int rounding", () => {
    expect(sql).toContain("win_epoch := floor(now_epoch / p_window_seconds) * p_window_seconds");
    expect(sql).toContain("cur_start := to_timestamp(win_epoch)");
    expect(sql).toMatch(/ceil\(p_window_seconds - \(now_epoch - win_epoch\)\)/);
    expect(sql).not.toContain("date_trunc");
    expect(sql).not.toMatch(/::int\s*%/);
  });

  it("stamps every row with expires_at and prunes expired rows of ANY key, bounded and lock-safe", () => {
    expect(sql).toContain("insert into nopm_rate_counters(rate_key, window_start, hits, expires_at)");
    expect(sql).toMatch(/where expires_at < now\(\) order by expires_at limit 100 for update skip locked/);
    // the old per-key-only cleanup is gone
    expect(sql).not.toMatch(/delete from nopm_rate_counters where rate_key = p_key/);
  });

  it("refuses an over-long key and an out-of-range window", () => {
    expect(sql).toContain("length(p_key) > 256");
    expect(sql).toMatch(/p_window_seconds < 1 or p_window_seconds > 3600/);
  });

  it("keeps the signature, the callers' contract, and service-role-only execution", () => {
    expect(sql).toContain("nopm_rate_check(p_key text, p_max int, p_window_seconds int) returns jsonb");
    const all = guardSql();
    expect(all).toContain("revoke execute on function nopm_rate_check(text, int, int) from public, anon, authenticated");
    expect(all).toContain("grant execute on function nopm_rate_check(text, int, int) to service_role");
    for (const key of ["'allowed'", "'remaining'", "'retry_after_seconds'"]) expect(sql).toContain(key);
  });

  it("adds expires_at (defaulted, so the previous function keeps working during a rolling deploy) and its index", () => {
    const all = guardSql();
    expect(all).toContain("alter table nopm_rate_counters add column if not exists expires_at timestamptz not null default");
    expect(all).toContain("create index if not exists nopm_rate_counters_expires_idx on nopm_rate_counters (expires_at)");
  });
});
