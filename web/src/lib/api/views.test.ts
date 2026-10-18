import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuleError } from "@/lib/api/errors";
import {
  FULL_COLUMNS,
  RISK_SELECT,
  SUMMARY_COLUMNS,
  parseListSelection,
  type ViewEntity,
} from "./views";

const ENTITIES = Object.keys(FULL_COLUMNS) as ViewEntity[];
const sp = (q: string) => new URLSearchParams(q);

describe("summary column lists (R-129)", () => {
  for (const e of ENTITIES) {
    it(`${e}: every summary column is in the full allow-list, no duplicates, id first`, () => {
      expect(SUMMARY_COLUMNS[e][0]).toBe("id");
      expect(new Set(SUMMARY_COLUMNS[e]).size).toBe(SUMMARY_COLUMNS[e].length);
      for (const c of SUMMARY_COLUMNS[e]) expect(FULL_COLUMNS[e]).toContain(c);
      expect(new Set(FULL_COLUMNS[e]).size).toBe(FULL_COLUMNS[e].length);
    });
    it(`${e}: summary is strictly leaner than full`, () => {
      expect(SUMMARY_COLUMNS[e].length).toBeLessThan(FULL_COLUMNS[e].length);
    });
    it(`${e}: summary carries no long-text or complement-seam columns`, () => {
      for (const c of ["description", "source", "external_ref", "external_url", "acceptance_criteria", "checklist"]) {
        expect(SUMMARY_COLUMNS[e], c).not.toContain(c);
      }
    });
  }

  it("projects summary has no charter or lock-detail columns", () => {
    for (const c of [
      "business_case", "objective", "scope_summary", "health_commentary", "description", "sponsor",
      "lock_reason", "locked_by", "locked_at", "baseline_start_date", "baseline_target_date",
    ]) {
      expect(SUMMARY_COLUMNS.projects, c).not.toContain(c);
    }
    expect(SUMMARY_COLUMNS.projects).toEqual(
      expect.arrayContaining(["id", "code", "name", "rag_status", "owner_id", "start_date", "target_date", "completion_pct", "is_locked", "updated_at"]),
    );
  });

  it("risks never expose the deprecated free-text category column", () => {
    expect(FULL_COLUMNS.risks).not.toContain("category");
    expect(SUMMARY_COLUMNS.risks).not.toContain("category");
    expect(RISK_SELECT.split(",")).not.toContain("category");
    expect(FULL_COLUMNS.risks).toContain("impact_areas");
  });

  it("every allow-listed column is defined on the RIGHT table in the migrations (read-only scan)", () => {
    const dir = join(__dirname, "..", "..", "..", "supabase", "migrations");
    const stmts = readdirAll(dir).split(";");
    for (const e of ENTITIES) {
      const own = stmts.filter((s) => new RegExp("(create table|alter table)[ ]+(if not exists[ ]+|only[ ]+)?(public[.])?" + e + "[^a-z0-9_]", "i").test(s));
      const text = own.join(";");
      for (const c of FULL_COLUMNS[e]) {
        expect(new RegExp("(^|[^a-z0-9_])" + c + "($|[^a-z0-9_])", "i").test(text), e + "." + c).toBe(true);
      }
    }
  });
});

function readdirAll(dir: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

describe("parseListSelection", () => {
  it("defaults to summary", () => {
    const r = parseListSelection(sp(""), "projects");
    expect(r.view).toBe("summary");
    expect(r.select.split(",")).toEqual([...SUMMARY_COLUMNS.projects]);
  });

  it("view=full is * (explicit list for risks)", () => {
    expect(parseListSelection(sp("view=full"), "tasks").select).toBe("*");
    expect(parseListSelection(sp("view=full"), "risks").select).toBe(FULL_COLUMNS.risks.join(","));
  });

  it("fields wins over view, always includes id, de-duplicates and trims", () => {
    const r = parseListSelection(sp("view=full&fields=name, rag_status,name"), "projects");
    expect(r.view).toBe("fields");
    expect(r.select).toBe("id,name,rag_status");
  });

  it("an empty fields value falls back to the view", () => {
    expect(parseListSelection(sp("fields="), "issues").view).toBe("summary");
  });

  it("rejects an unknown field, naming it and the allow-list (422)", () => {
    expect(() => parseListSelection(sp("fields=name,password"), "projects")).toThrow(RuleError);
    expect(() => parseListSelection(sp("fields=name,password"), "projects")).toThrow(/"password"/);
  });

  it("rejects the deprecated risk category as a field", () => {
    expect(() => parseListSelection(sp("fields=category"), "risks")).toThrow(RuleError);
  });

  it("rejects an unknown view", () => {
    expect(() => parseListSelection(sp("view=verbose"), "tasks")).toThrow(/summary.*full/);
  });

  it("cannot be used to select another table's column or a PostgREST embed", () => {
    expect(() => parseListSelection(sp("fields=id,profiles(email)"), "projects")).toThrow(RuleError);
    expect(() => parseListSelection(sp("fields=*"), "tasks")).toThrow(RuleError);
  });
});

describe("risks output carries impact_areas only (UAT-028)", () => {
  it("the single impact_area is accepted on input but never selected or returned", () => {
    expect(FULL_COLUMNS.risks).not.toContain("impact_area");
    expect(RISK_SELECT.split(",")).not.toContain("impact_area");
    expect(parseListSelection(sp("view=full"), "risks").select.split(",")).not.toContain("impact_area");
    expect(FULL_COLUMNS.risks).toContain("impact_areas");
  });
});
