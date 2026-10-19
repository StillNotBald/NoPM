import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { libFileNonAtomic, nonAtomicHandlers, verbSpans, walkFiles } from "./atomicity-scan";

/**
 * M1 atomicity (audit finding: about 59 handlers wrote the change first and the audit
 * row afterwards). Text scan over EVERY route handler under src/app/api and EVERY
 * library file under src/lib: no `writeAudit(` may come AFTER a direct insert / update /
 * delete / upsert on the admin client. Such code must use the atomic wrapper
 * (audited-write.ts) or an RPC that audits inside SQL.
 *
 * EXCEPTIONS is the complete, honest list of what is still non-atomic, each with a
 * reason and an owner. An entry that has become atomic fails the build until its line
 * is deleted, so the list can only shrink.
 */

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "app", "api");

type Exception = { reason: string; owner: string };

const ex = (owner: string, reason: string): Exception => ({ owner, reason });

/** "<api path>#<VERB>" for a route, "lib/<path>.ts" for a library file. */
import { EXCEPTIONS as GOVERNANCE } from "./atomicity-exceptions-governance";
import { EXCEPTIONS as SECURITY } from "./atomicity-exceptions-security";
import { EXCEPTIONS as JOBS } from "./atomicity-exceptions-jobs";

/** Merged from the three per-builder slices (wave-5 Pre-1); the slices must not overlap. */
const EXCEPTIONS: Record<string, Exception> = { ...GOVERNANCE, ...SECURITY, ...JOBS };
const SLICE_SIZES = { governance: Object.keys(GOVERNANCE).length, security: Object.keys(SECURITY).length, jobs: Object.keys(JOBS).length };
if (SLICE_SIZES.governance + SLICE_SIZES.security + SLICE_SIZES.jobs !== Object.keys(EXCEPTIONS).length) {
  throw new Error("atomicity exception slices overlap: " + JSON.stringify(SLICE_SIZES));
}


function scanAll(): string[] {
  const found: string[] = [];
  for (const f of walkFiles(SRC, /\.ts$/)) {
    const rel = f.split("\\").join("/").split("/src/")[1];
    if (/\.test\.ts$/.test(rel) || rel.includes("test-support") || rel === "lib/audit/atomicity-scan.ts") continue;
    const src = readFileSync(f, "utf8");
    if (rel.startsWith("app/api/") && rel.endsWith("/route.ts")) {
      found.push(...nonAtomicHandlers(src, rel.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "")));
    } else if (rel.startsWith("lib/") && libFileNonAtomic(src)) {
      found.push(rel);
    }
  }
  return found.sort();
}

function pathOf(id: string): string {
  return id.startsWith("lib/") ? join(SRC, id) : join(API_DIR, id.split("#")[0], "route.ts");
}

describe("M1 atomicity: a change and its audit row are written together", () => {
  it("scans the whole code base", () => {
    expect(walkFiles(API_DIR, /^route\.ts$/).length).toBeGreaterThan(80);
  });

  it("no route handler or library writer audits after a direct write, except the listed ones", () => {
    const violations = scanAll().filter((id) => !EXCEPTIONS[id]);
    expect(violations).toEqual([]);
  });

  it("every exception is real, still non-atomic, and has an owner and a reason", () => {
    const found = new Set(scanAll());
    const problems: string[] = [];
    for (const [id, e] of Object.entries(EXCEPTIONS)) {
      if (!existsSync(pathOf(id))) {
        problems.push(`${id}: file does not exist`);
        continue;
      }
      if (!found.has(id)) problems.push(`${id}: is atomic now, delete its line from EXCEPTIONS`);
      if (e.reason.trim().length < 30) problems.push(`${id}: reason too short`);
      if (e.owner.trim().length < 3) problems.push(`${id}: owner missing`);
      if (id.includes("#") && !verbSpans(readFileSync(pathOf(id), "utf8")).some((s) => s.verb === id.split("#")[1])) {
        problems.push(`${id}: no such verb`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("the converted route group uses the wrapper", () => {
    const users = walkFiles(API_DIR, /^route\.ts$/)
      .filter((f) => /audited(?:Insert|Update|Delete)\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.split("\\").join("/").split("src/app/api/")[1].replace(/\/route\.ts$/, ""));
    for (const expected of [
      "projects",
      "projects/[id]",
      "projects/[id]/tasks",
      "projects/[id]/milestones",
      "projects/[id]/risks",
      "projects/[id]/issues",
      "projects/[id]/expenses",
      "projects/[id]/dependencies",
      "projects/[id]/dependencies/[depId]",
      "tasks/[id]",
      "tasks/[id]/dependencies",
      "milestones/[id]",
      "risks/[id]",
      "issues/[id]",
      "clashes",
      "clashes/[id]",
      "programs",
      "programs/[id]",
      "sprints",
      "sprints/[id]",
      "sprints/[id]/start",
      "sprints/[id]/tasks",
      "allocations",
      "allocations/[id]",
      "resources",
      "resources/[id]",
      "saved-views",
      "saved-views/[id]",
      "saved-views/[id]/duplicate",
      "calendar-feeds",
      "calendar-feeds/[id]",
    ]) {
      expect(users, expected).toContain(expected);
    }
  });

  it("the detector sees mutate-then-audit and ignores audit-then-mutate and blocked-attempt audits", () => {
    const bad = [
      "export const PATCH = route(async () => {",
      '  await db.from("tasks").update({ a: 1 }).eq("id", 1);',
      '  await writeAudit({ action: "task.update" });',
      "});",
    ].join("\n");
    const good = [
      "export const PATCH = route(async () => {",
      '  await assertProjectUnlocked(db, 1, 2, () => writeAudit({ action: "task.update.blocked" }));',
      '  const row = await auditedUpdate({ table: "tasks", action: "task.update" });',
      "});",
    ].join("\n");
    expect(nonAtomicHandlers(bad, "tasks/[id]")).toEqual(["tasks/[id]#PATCH"]);
    expect(nonAtomicHandlers(good, "tasks/[id]")).toEqual([]);
    expect(libFileNonAtomic('await db.from("x").insert({});\nawait writeAudit({});')).toBe(true);
    expect(libFileNonAtomic('await writeAudit({});\nawait db.from("x").insert({});')).toBe(false);
  });
});
