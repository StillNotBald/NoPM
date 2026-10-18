/** Migration-text test for 0094 (document evidence, R-137). Read-only SQL scan. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const m = strip(readFileSync(join(dir, "20261018000094_document_evidence.sql"), "utf8"));

describe("0094 document evidence", () => {
  it("adds every column nullable and idempotently", () => {
    for (const col of ["change_request_id uuid", "evidence_type     text", "evidence_result   text", "tested_by_label   text", "tested_at         timestamptz", "evidence_note     text"]) {
      expect(m).toContain(`add column if not exists ${col}`);
    }
    expect(m).not.toMatch(/add column[^;]*\bnot null\b/i);
  });

  it("links to change_requests and keeps the file when the request is deleted", () => {
    expect(m).toMatch(/change_request_id uuid references change_requests\(id\) on delete set null/);
    expect(m).toMatch(/create index if not exists documents_change_request_idx\s+on documents \(change_request_id\)/);
  });

  it("checks type and result values, and a result needs a type", () => {
    expect(m).toMatch(/evidence_type in \('test_result', 'uat_signoff', 'deploy_record', 'screenshot', 'other'\)/);
    expect(m).toMatch(/evidence_result in \('pass', 'fail', 'partial', 'n\/a'\)/);
    expect(m).toMatch(/evidence_result is null or evidence_type is not null/);
  });

  it("has no backfill, so no trigger is touched and none is left disabled", () => {
    expect(m).not.toMatch(/\bupdate documents\b/i);
    expect(m).not.toMatch(/disable trigger/i);
    expect(m).not.toMatch(/drop (table|column)|\bdelete from\b|\btruncate\b/i);
  });

  it("clears the evidence columns at the database when the link becomes null (W2-07)", () => {
    expect(m).toMatch(/before update of change_request_id on documents/);
    expect(m).toMatch(/if new.change_request_id is null then/);
    for (const c of ["evidence_type", "evidence_result", "tested_by_label", "tested_at", "evidence_note"]) {
      expect(m).toContain("new." + c + " ");
    }
  });
});
