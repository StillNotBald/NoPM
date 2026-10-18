/**
 * Wave 5, W5-J (R-180): the owner's post-release checklist stays read-only and stays in step with the release.
 *
 * CUTOVER/12 is pasted into the live SQL editor by the owner. A single stray write in it would be a live write,
 * so every ```sql block is scanned: only select statements, none of the write or definition words, even in a
 * comment. CUTOVER/14 spells out the two-phase release; its rollback lines must match the real 0114 triggers and
 * the rehearsal must hold the same file back.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const checks = read("CUTOVER", "12-POST-RELEASE-CHECKS.md");
const release = read("CUTOVER", "14-WAVE5-RELEASE.md");
const sqlBlocks = [...checks.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);

const FORBIDDEN = ["insert", "update", "delete", "alter", "drop", "create", "truncate", "grant"];

describe("CUTOVER/12 post-release checks (R-180)", () => {
  it("has the five groups and at least twenty SQL blocks", () => {
    for (const g of ["Group 0", "Group 1", "Group 2", "Group 3", "Group 4"]) expect(checks).toContain(g);
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(20);
  });

  it("says at the top that nothing in it targets the live system", () => {
    const top = checks.slice(0, 1500).toLowerCase();
    expect(top).toContain("every statement in this file is a `select`");
    expect(top).toContain("no probe, request or script in this file targets the live system");
  });

  it("every SQL block contains only select statements", () => {
    for (const block of sqlBlocks) {
      const bare = block.replace(/--[^\n]*/g, "");
      for (const stmt of bare.split(";").map((s) => s.trim()).filter(Boolean)) {
        expect(stmt, `statement does not start with select or with: ${stmt.slice(0, 80)}`).toMatch(/^(select|with)\b/i);
      }
    }
  });

  it("no SQL block contains a write or definition word, comments included", () => {
    for (const block of sqlBlocks) {
      for (const word of FORBIDDEN) {
        const hit = new RegExp(`\\b${word}\\b`, "i").exec(block);
        expect(hit, `"${word}" appears in a SQL block: ${block.slice(0, 80)}`).toBeNull();
      }
    }
  });

  it("covers the live checks the builders asked for", () => {
    for (const needle of [
      "convalidated",
      "projects_lock_integrity",
      "deletion_requests_target_type_check",
      "cr_maker_checker",
      "nopm_audit_verify_chain",
      "audit_anchor_receipts",
      "backup_codes",
      "00000000-0000-0000-0000-000000000000",
      "system (migration 0106)",
      "trg\\_%\\_delete\\_needs\\_request",
    ]) {
      expect(checks, needle).toContain(needle);
    }
  });
});

describe("CUTOVER/14 wave 5 release (R-180)", () => {
  it("spells out the two phases and the single database rollback", () => {
    expect(release).toContain("phase 1");
    expect(release).toContain("phase 2");
    expect(release).toContain("vercel rollback");
    expect(release).toContain("NOPM_ANCHOR_DB_URL");
  });

  it("its rollback lines are the real 0114 triggers", () => {
    const mig = read("web", "supabase", "migrations", "20261018000114_deletion_refuse_triggers.sql");
    for (const t of ["programs", "sprints", "resource_members", "allocations", "clashes"]) {
      const line = `drop trigger if exists trg_${t}_delete_needs_request on ${t};`;
      expect(mig, line).toContain(line);
      expect(release, line).toContain(line);
    }
  });

  it("the rehearsal holds back the same file and refuses non-loopback targets", () => {
    const src = read("web", "scripts", "local-db", "rehearse-wave5.mjs");
    expect(src).toContain('import { stack } from "./guard.mjs"');
    expect(src).toContain('HELD_BACK = "20261018000114"');
    expect(existsSync(join(ROOT, "web", "supabase", "migrations", "20261018000114_deletion_refuse_triggers.sql"))).toBe(true);
  });
});
