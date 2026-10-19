import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

/**
 * Guard test for the one failure only `next build` reports (2026-10-19 wave-5 release stopped at the
 * Vercel build): a `"use client"` component that, through any chain of static imports, reaches a module
 * importing `next/headers` (or `server-only`). vitest and tsc both pass such a tree because the modules
 * are plain TypeScript; Turbopack refuses it ("You're importing a module that depends on next/headers").
 *
 * The chain that broke: components/review/inline-action.tsx (client) -> lib/review/deletion-target.ts
 * -> lib/review/pending.ts -> lib/governance/deletion-dispatch.ts -> lib/auth/guard.ts -> next/headers.
 *
 * Static parse: `import ... from "x"`, `export ... from "x"` and `import("x")` with a string literal,
 * resolving `@/` and relative specifiers to .ts/.tsx/.js/.mjs or an index file. Type-only imports
 * (`import type`) are erased by the compiler, so they are skipped. Packages are not followed.
 */

const SRC = join(process.cwd(), "src");
const SERVER_ONLY = /^(next\/headers|server-only)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export function specifiers(src: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src))) {
    if (m[1]) continue; // import type / export type: erased
    const spec = m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // package
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const isClient = (src: string) => /^\s*(['"])use client\1\s*;?/.test(src.replace(/^﻿/, "").replace(/^(\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/, ""));

describe("client/server boundary (what only `next build` would otherwise catch)", () => {
  const files = walk(SRC);
  const srcOf = new Map(files.map((f) => [f, readFileSync(f, "utf8")] as const));
  const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");

  const serverOnly = new Set(files.filter((f) => specifiers(srcOf.get(f)!).some((s) => SERVER_ONLY.test(s))));
  const clientFiles = files.filter((f) => isClient(srcOf.get(f)!));

  it("finds client components and server-only modules", () => {
    expect(clientFiles.length).toBeGreaterThan(30);
    expect(serverOnly.size).toBeGreaterThan(5);
    expect([...serverOnly].map(rel)).toContain("lib/auth/guard.ts");
  });

  it("no client component reaches next/headers through static imports", () => {
    const violations: string[] = [];
    for (const start of clientFiles) {
      // BFS over value imports; remember the parent to print the chain.
      const parent = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      let hit: string | null = null;
      while (queue.length && !hit) {
        const cur = queue.shift()!;
        for (const spec of specifiers(srcOf.get(cur) ?? "")) {
          const next = resolveSpec(cur, spec);
          if (!next || parent.has(next)) continue;
          parent.set(next, cur);
          if (serverOnly.has(next)) { hit = next; break; }
          queue.push(next);
        }
      }
      if (hit) {
        const chain: string[] = [];
        for (let f: string | null = hit; f; f = parent.get(f) ?? null) chain.unshift(rel(f));
        violations.push(chain.join(" -> "));
      }
    }
    expect(violations).toEqual([]);
  });

  it("the parser reads value imports and skips type-only ones", () => {
    const src = `import type { A } from "./a";\nimport { b } from "@/lib/b";\nexport { c } from "../c";\nconst d = await import("./d");\nimport "./side";`;
    expect(specifiers(src)).toEqual(["@/lib/b", "../c", "./d", "./side"]);
  });
});
