/** Migration-text tests for 0090 (risks.category deprecation) and 0091 (risks.impact_areas). Read-only SQL scans. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const strip = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");
const m90 = strip(readFileSync(join(dir, "20261018000090_risk_category_deprecate.sql"), "utf8"));
const m91 = strip(readFileSync(join(dir, "20261018000091_risk_impact_areas.sql"), "utf8"));

describe("0090 risk category deprecation", () => {
  it("is a comment only: no drop, no data change", () => {
    expect(m90).toMatch(/comment on column risks\.category is\s+'deprecated 2026-10-18: use risk_category; dropped in a later release'/);
    expect(m90).not.toMatch(/\b(drop|delete|truncate|alter|update|insert)\b/i);
  });
});

describe("0091 risk impact_areas", () => {
  it("adds a not-null enum array defaulting to empty, idempotently", () => {
    expect(m91).toMatch(/add column if not exists impact_areas risk_impact_area\[\] not null default '\{\}'/);
  });

  it("backfills from impact_area BEFORE the sync trigger exists", () => {
    const backfill = m91.indexOf("update risks");
    const trigger = m91.indexOf("create trigger trg_risks_sync_impact_area");
    expect(backfill).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(backfill);
    expect(m91).toMatch(/set impact_areas = array\[impact_area\]/);
  });

  it("keeps impact_area = first element, and the array wins when both are written", () => {
    expect(m91).toMatch(/before insert or update on risks/);
    expect(m91).toContain("new.impact_area := new.impact_areas[1]");
    expect(m91).toContain("new.impact_areas := array[new.impact_area]");
    expect(m91).toContain("set search_path = public");
  });

  it("drops nothing and never deletes data", () => {
    expect(m91).not.toMatch(/drop (table|column|type)/i);
    expect(m91).not.toMatch(/\bdelete from\b|\btruncate\b/i);
  });
});

describe("0091 pauses the updated_at trigger around its backfill (W1-03)", () => {
  it("disables trg_risks_updated before the UPDATE and re-enables it right after", () => {
    const off = m91.indexOf("alter table risks disable trigger trg_risks_updated");
    const upd = m91.indexOf("update risks");
    const on = m91.indexOf("alter table risks enable trigger trg_risks_updated");
    expect(off).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(off);
    expect(on).toBeGreaterThan(upd);
    expect(m91.indexOf("create trigger trg_risks_sync_impact_area")).toBeGreaterThan(on);
  });
});
