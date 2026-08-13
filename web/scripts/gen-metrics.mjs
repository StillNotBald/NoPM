#!/usr/bin/env node
/**
 * gen-metrics.mjs — generate the case-study proof metrics FROM the repo
 * instead of hand-typing them into marketing copy.
 *
 *   rids       unique R-IDs in requirements/REQUIREMENTS.md
 *   endpoints  documented REST endpoints (route.ts files under src/app/api,
 *              excluding the openapi.json route itself — the OpenAPI coverage
 *              test guarantees every one of these is documented in the spec)
 *   tests      vitest test count (run with --reporter=json)
 *
 * Output: src/lib/metrics.gen.json — imported by the landing page, the case
 * study, and the PDF one-pager. Checked in; CI runs `--check` to fail the
 * build if the numbers drift from reality (same-commit discipline, like RTM).
 *
 * Usage:  node scripts/gen-metrics.mjs           regenerate the file
 *         node scripts/gen-metrics.mjs --check   exit 1 if the file is stale
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(WEB, "..");
const OUT = path.join(WEB, "src", "lib", "metrics.gen.json");

// ── R-IDs ─────────────────────────────────────────────────────────────────────

function countRids() {
  const text = readFileSync(path.join(REPO, "requirements", "REQUIREMENTS.md"), "utf8");
  const ids = new Set(text.match(/\bR-\d+\b/g) ?? []);
  return ids.size;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

function countEndpoints() {
  const apiDir = path.join(WEB, "src", "app", "api");
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts" && !full.includes("openapi.json")) count++;
    }
  };
  walk(apiDir);
  return count;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

function countTests() {
  const raw = execSync("npx vitest run --reporter=json", {
    cwd: WEB,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  // vitest may print non-JSON banner lines; the report is the last JSON object
  const start = raw.indexOf("{");
  const report = JSON.parse(raw.slice(start));
  if (!report.success) {
    console.error("gen-metrics: vitest reported failures — fix tests before regenerating metrics.");
    process.exit(1);
  }
  return { tests: report.numTotalTests, testFiles: report.numTotalTestSuites };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const { tests } = countTests();
const metrics = {
  rids: countRids(),
  endpoints: countEndpoints(),
  tests,
};

const next = JSON.stringify(metrics, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch {}
  if (current !== next) {
    console.error("✗ metrics.gen.json is stale. Regenerate with: node scripts/gen-metrics.mjs");
    console.error("  checked-in:", current.trim() || "(missing)");
    console.error("  actual:    ", next.trim());
    process.exit(1);
  }
  console.log("✓ metrics.gen.json matches reality:", next.trim());
} else {
  writeFileSync(OUT, next);
  console.log("wrote", OUT, "→", next.trim());
}
