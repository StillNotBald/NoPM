/**
 * Migration-text test for 0064 (cascade audit rows + never-reused reference
 * numbers) and 0065 (documents bucket size limit). No live Postgres in this
 * suite, so the SQL text is asserted, like principal-migration.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const m64 = readFileSync(join(dir, "20261017000064_governed_children_audit_and_refs.sql"), "utf8");
const m65 = readFileSync(join(dir, "20261017000065_documents_bucket_limit.sql"), "utf8");
const m56 = readFileSync(join(dir, "20261017000056_review_fixes.sql"), "utf8");

const fnBody = (text: string) => {
  const start = text.indexOf("create or replace function nopm_commit_project_deletion(");
  const end = text.indexOf("revoke execute on function nopm_commit_project_deletion", start);
  return text.slice(start, end);
};

describe("0064 cascade audit", () => {
  const body = fnBody(m64);
  it("keeps the 0056 signature, grants and every guard", () => {
    const old = fnBody(m56);
    for (const guard of ["INVALID_CHANNEL", "NO_PRINCIPAL", "NOT_FOUND", "ALREADY_DECIDED", "SELF_APPROVAL", "PROJECT_LOCKED", "TARGET_GONE"]) {
      expect(old).toContain(guard);
      expect(body).toContain(guard);
    }
    expect(m64).toMatch(/revoke execute on function nopm_commit_project_deletion\([^)]*\) from public, anon, authenticated/);
    expect(m64).toMatch(/grant\s+execute on function nopm_commit_project_deletion\([^)]*\) to service_role/);
    expect(body).toContain("set search_path = public");
  });
  it("audits every governed child kind, before the delete, in the same function", () => {
    for (const a of ["change_request", "decision", "document", "rebaseline_signoff", "rebaseline"]) {
      expect(body).toContain(`'${a}.cascade_delete'`);
    }
    expect(body.indexOf("change_request.cascade_delete")).toBeLessThan(body.indexOf("delete from projects"));
  });
});

describe("0064 reference numbers", () => {
  it("has a service-only counter function and a guarded unique index per register", () => {
    expect(m64).toContain("create or replace function nopm_next_ref(");
    expect(m64).toMatch(/grant\s+execute on function nopm_next_ref\(uuid, text\) to service_role/);
    expect(m64).toContain("greatest(c.last_value, v_max) + 1");
    for (const t of ["change_requests", "decisions", "documents"]) {
      expect(m64).toContain(`uniq_${t}_reference`);
    }
    expect(m64).toContain("raise notice");
  });
});

describe("0065 bucket limit", () => {
  it("sets the 25 MiB limit on the documents bucket idempotently", () => {
    expect(m65).toContain("update storage.buckets");
    expect(m65).toContain("file_size_limit = 26214400");
    expect(m65).toContain("where id = 'documents'");
  });
});
