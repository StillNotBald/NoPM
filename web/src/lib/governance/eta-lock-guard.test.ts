/**
 * Guard for R-166 (W1-14): nothing that forecasts, reports or nudges reads a task's `eta` yet.
 *
 * Owner decision (recorded for W5-D): `tasks.eta` and `tasks.blocker_reason` are NOT schedule-shape fields, so
 * they stay editable on a locked project, like `blocked_by`. That is only safe while `eta` is informational.
 * The day a forecasting module (insight, EVM, snapshots, reports, nudges) consumes `eta`, the lock question
 * must be decided again: either freeze `eta` under a lock (move it to SCHEDULE_SHAPE_TASK_FIELDS and the
 * database backstop) or accept that a locked baseline's forecast can move. This test fails the moment a
 * module in those folders reads it, so that decision cannot be skipped.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "src/lib");

/** Folders and file prefixes that forecast, report or nudge. */
const GUARDED_DIRS = ["insight", "reports", "nudges"];
const GUARDED_FILE_PREFIXES = ["evm"]; // evm.ts, evm-forecast.ts, and any later evm*

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

function guardedFiles(): string[] {
  const files = GUARDED_DIRS.flatMap((d) => walk(join(root, d)));
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (GUARDED_FILE_PREFIXES.some((pre) => name.startsWith(pre)) && statSync(p).isFile() && !/\.test\./.test(name)) {
      files.push(p);
    }
  }
  return files;
}

// `.eta`, `["eta"]`, `'eta'`, or `eta` as a selected column name in a select string or destructuring.
const READS_ETA = /\.eta\b|\[\s*["']eta["']\s*\]|["'`,\s{]eta["'`,\s}:]/;

describe("no forecasting, reporting or nudge module reads task eta (R-166)", () => {
  const files = guardedFiles();

  it("the guard actually covers the folders (not an empty scan)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.includes("evm"))).toBe(true);
    expect(files.some((f) => f.includes("snapshots"))).toBe(true);
  });

  it("none of them mentions eta", () => {
    const offenders = files.filter((f) => READS_ETA.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(root, "src/lib"))).toEqual([]);
  });
});
