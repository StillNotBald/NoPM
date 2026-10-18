import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCUMENT_EVIDENCE_COLUMNS, DOCUMENT_REGISTER_COLUMNS } from "./columns";

const EVIDENCE = ["change_request_id", "evidence_type", "evidence_result", "tested_by_label", "tested_at", "evidence_note"];

describe("document register select carries every evidence column (UAT-008)", () => {
  it("the shared list names all six", () => {
    for (const c of EVIDENCE) {
      expect(DOCUMENT_EVIDENCE_COLUMNS.split(", ")).toContain(c);
      expect(DOCUMENT_REGISTER_COLUMNS.split(", ")).toContain(c);
    }
  });

  it("the Documents page and the project page select through the shared list", () => {
    const src = (p: string) => readFileSync(join(__dirname, "..", "..", "app", "(console)", ...p.split("/")), "utf8");
    expect(src("documents/page.tsx")).toContain(".select(DOCUMENT_REGISTER_COLUMNS)");
    expect(src("projects/[id]/page.tsx")).toContain("${DOCUMENT_EVIDENCE_COLUMNS}");
  });
});
