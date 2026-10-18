import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (f: string) => f.split("\\").join("/").split("/src/")[1];

describe("anchor module boundaries", () => {
  const files = walk(SRC);

  it("`pg` is imported only inside postgres-sink.ts (R-168f)", () => {
    const importers = files
      .filter((f) => /from\s+["']pg["']|require\(["']pg["']\)/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(importers).toEqual(["lib/audit/anchor/postgres-sink.ts"]);
  });

  it("the connection string is read in one place and never logged or returned", () => {
    const readers = files.filter((f) => /env\.NOPM_ANCHOR_DB_URL/.test(readFileSync(f, "utf8"))).map(rel);
    expect(readers).toEqual(["lib/audit/anchor/get-sink.ts"]);
    for (const f of files.filter((x) => rel(x).startsWith("lib/audit/anchor/"))) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/console\.\w+\([^)]*(process\.env|connectionString|\burl\b)/);
    }
  });

  it("the Postgres sink is the only thing the rest of the app reaches for through get-sink", () => {
    const importers = files
      .filter((f) => /["']\.\/postgres-sink["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual(["lib/audit/anchor/get-sink.ts"]);
  });
});
