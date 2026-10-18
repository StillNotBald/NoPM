import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTION_GLOSSARY } from "./action-glossary";

/**
 * Drift guard: the glossary must equal the set of audit actions the codebase
 * can actually write. Sources scanned: writeAudit({ action: "..." }) call
 * sites, the saved-view action resolver, and SQL migrations that insert into
 * audit_log (RPCs).
 */
const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, match));
    else if (match.test(e.name)) out.push(p);
  }
  return out;
}

function codeActions(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(SRC, /\.tsx?$/)) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const s = readFileSync(file, "utf8");
    let i = -1;
    while ((i = s.indexOf("writeAudit(", i + 1)) >= 0) {
      const m = s.slice(i, i + 700).match(/action:\s*"([^"]+)"/);
      if (m) found.add(m[1]);
    }
    // Actions written through a named constant (e.g. OVERSPEND_AUDIT_ACTION).
    for (const m of s.matchAll(/const\s+\w*AUDIT_ACTION\w*\s*=\s*"([^"]+)"/g)) found.add(m[1]);
  }
  const sv = readFileSync(join(SRC, "app", "api", "saved-views", "_visibility.ts"), "utf8");
  for (const m of sv.matchAll(/return\s+"(saved_view\.[a-z_]+)"/g)) found.add(m[1]);
  return found;
}

function sqlActions(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(MIGRATIONS, /\.sql$/)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!/insert\s+into\s+(public\.)?audit_log/i.test(line)) return;
      const window = lines.slice(idx, idx + 16).join("\n");
      for (const m of window.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)) found.add(m[1]);
    });
  }
  return found;
}

describe("audit action glossary", () => {
  const listed = AUDIT_ACTION_GLOSSARY.map((e) => e.action);

  it("has no duplicates and a description for every action", () => {
    expect(new Set(listed).size).toBe(listed.length);
    for (const e of AUDIT_ACTION_GLOSSARY) expect(e.description.length).toBeGreaterThan(3);
  });

  it("covers every action written in code or SQL", () => {
    const written = new Set([...codeActions(), ...sqlActions()]);
    expect(written.size).toBeGreaterThan(50);
    const missing = [...written].filter((a) => !listed.includes(a));
    expect(missing).toEqual([]);
  });

  it("lists no action that is never written", () => {
    const written = new Set([...codeActions(), ...sqlActions()]);
    const stale = listed.filter((a) => !written.has(a));
    expect(stale).toEqual([]);
  });
});
