/**
 * Four-eyes backfill + validate - migration-text drift test (migration 0089, G6 caveats).
 *
 * Text scan only (no live Postgres in this suite), but it asserts the real clauses:
 * the requester is derived from requester evidence only (never a decision row),
 * a would-be self-approval is skipped, each statement sits in its own exception
 * block, and every CHECK is validated in a block that skips with a notice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "20261018000089_four_eyes_backfill_validate.sql";
const text = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", FILE), "utf8").replace(/\r\n/g, "\n");
/** The SQL without its comment header, so prose cannot satisfy or break an assertion. */
const sql = text.replace(/^\s*--.*$/gm, "");

describe("0089 four-eyes backfill + validate", () => {
  it("derives the requester from users, token creators and the RAISE audit rows", () => {
    expect(sql).toMatch(/requested_by_type = 'user'/);
    expect(sql).toMatch(/join api_tokens t on t\.id = cr\.requested_by_id/);
    expect(sql).toMatch(/join api_tokens t on t\.id = dr\.requested_by_id/);
    expect(sql).toMatch(/action = 'change_request\.create'/);
    expect(sql).toMatch(/action = dr\.target_type \|\| '\.delete_requested'/);
    expect(sql).toMatch(/created_at <= dr\.created_at/);
  });

  it("never reads a decision row (a deletion_request audit target is written only by the decision paths)", () => {
    expect(sql).not.toMatch(/target_type = 'deletion_request'/);
    expect(sql).not.toMatch(/deletion_request\.(approved|rejected|withdrawn)/);
    expect(sql).not.toMatch(/action like/i);
  });

  it("skips a row whose derived requester equals the stored decider / approver, and counts it", () => {
    expect(sql).toMatch(/cr\.decided_principal_id is null or cr\.decided_principal_id <> c\.principal/);
    expect(sql).toMatch(/dr\.approved_principal_id is null or dr\.approved_principal_id <> c\.principal/);
    expect(sql).toMatch(/decided_principal_id is null or decided_principal_id <> submitted_by/);
    expect(text).toMatch(/self-approval on record, left unfilled/);
  });

  it("only ever fills NULL principals (never overwrites evidence)", () => {
    const updates = sql.match(/update (change_requests|deletion_requests|timesheet_submissions)[^;]*;/gi) ?? [];
    expect(updates.length).toBe(4);
    for (const u of updates) expect(u).toMatch(/_principal_id is null/);
  });

  it("wraps every backfill statement in its own exception block", () => {
    const blocks = sql.match(/\n {2}begin\n[\s\S]*?exception when others then\s+raise notice '0089: [a-z_ -]+ backfill skipped/g) ?? [];
    expect(blocks.length).toBe(4);
  });

  it("logs how many rows cannot be derived", () => {
    expect(text).toMatch(/still have no requester principal/);
    expect(text).toMatch(/four_eyes\.legacy_requester_unknown/);
  });

  it("validates each of the three CHECKs in its own exception block that skips with a notice", () => {
    for (const [table, name] of [
      ["change_requests", "cr_principal_distinct"],
      ["deletion_requests", "deletion_principal_distinct"],
      ["timesheet_submissions", "ts_principal_distinct"],
    ]) {
      const re = new RegExp(
        String.raw`alter table ${table} validate constraint ${name};[\s\S]*?exception when others then\s+raise notice '0089: ${name} left NOT VALID`,
      );
      expect(sql, name).toMatch(re);
    }
  });

  it("pauses and restores the updated_at triggers around the backfill", () => {
    expect(sql).toMatch(/disable trigger trg_change_requests_updated/);
    expect(sql).toMatch(/enable trigger trg_change_requests_updated/);
  });

  it("does not weaken audit immutability", () => {
    expect(sql).not.toMatch(/(update|delete from|truncate)\s+audit_log/i);
  });
});
