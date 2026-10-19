import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * M1 atomicity, route group 2 (documents, decisions, members, invites, tokens, notifications,
 * integrations, assistant, me, budget). Same rule as atomicity.test.ts (route group 1): no
 * `writeAudit(` may come AFTER a direct insert / update / delete / upsert on the admin client
 * in the same verb. Such a handler must use the atomic wrapper (audited-write.ts) or an RPC
 * that audits inside SQL. A separate file so the two agents never edit the same list.
 *
 * Left as they are, each with the reason, are the handlers below. Members and notifications have
 * nothing to convert: member changes are already RPCs (migration 0083) and notification
 * mark-read is inbox bookkeeping that has no audit row.
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

const DIRS = ["documents", "decisions", "members", "invites", "tokens", "notifications", "integrations", "assistant", "me"];
const PROJECT_SUBROUTES = ["projects/[id]/decisions", "projects/[id]/budget"];

import { EXCEPTIONS as SECURITY_SLICE } from "./atomicity-exceptions-security";

/**
 * Wave-5 Pre-1: the two connector entries live in the security slice (owner W5-B) so one builder
 * deletes them from one file when the routes become atomic. This list is derived, never edited here.
 */
const CONNECTOR_KEYS = ["integrations/connectors#POST", "integrations/connectors/[id]#PATCH"] as const;
const EXCEPTIONS: Record<string, string> = Object.fromEntries(
  CONNECTOR_KEYS.filter((k) => k in SECURITY_SLICE).map((k) => [k, SECURITY_SLICE[k].reason]),
);


function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}
const toApiPath = (abs: string) => abs.replace(/\\/g, "/").split("src/app/api/")[1].replace(/\/route\.ts$/, "");

function directWrites(src: string): number[] {
  const out: number[] = [];
  const re = /\.from\(\s*["'`](\w+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let j = m.index;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth < 0) break;
      } else if (c === ";" && depth === 0) break;
    }
    if (/\.(insert|update|delete|upsert)\(/.test(src.slice(m.index, j))) out.push(m.index);
  }
  return out;
}

function verbSpans(src: string): { verb: string; start: number; end: number }[] {
  const marks: { verb: string; at: number }[] = [];
  const re = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) marks.push({ verb: m[1], at: m.index });
  return marks.map((mk, i) => ({ verb: mk.verb, start: mk.at, end: marks[i + 1]?.at ?? src.length }));
}

function nonAtomicHandlers(src: string, apiPath: string): string[] {
  const writes = directWrites(src);
  const audits = [...src.matchAll(/writeAudit\s*\(/g)].map((m) => m.index as number);
  const bad: string[] = [];
  for (const span of verbSpans(src)) {
    const first = writes.filter((w) => w >= span.start && w < span.end);
    if (first.length === 0) continue;
    const earliest = Math.min(...first);
    if (audits.some((a) => a > earliest && a < span.end)) bad.push(`${apiPath}#${span.verb}`);
  }
  return bad;
}

describe("M1 atomicity: route group 2 writes the change and its audit row together", () => {
  const files = [
    // integrations/github is the work-events agent's (wave 4); everything else under integrations is in scope.
    ...DIRS.flatMap((d) => walk(join(API_DIR, d))).filter((f) => !toApiPath(f).startsWith("integrations/github")),
    ...PROJECT_SUBROUTES.flatMap((d) => walk(join(API_DIR, d))),
  ];

  it("finds the group-2 route files", () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it("no group-2 handler calls writeAudit( after a direct write, except the listed ones", () => {
    const violations: string[] = [];
    for (const f of files) {
      for (const id of nonAtomicHandlers(readFileSync(f, "utf8"), toApiPath(f))) {
        if (!EXCEPTIONS[id]) violations.push(id);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every exception names a real handler, has a real reason, and is still non-atomic", () => {
    const problems: string[] = [];
    for (const [id, reason] of Object.entries(EXCEPTIONS)) {
      const [apiPath, verb] = id.split("#");
      const abs = join(API_DIR, apiPath, "route.ts");
      if (!existsSync(abs)) {
        problems.push(`${id}: route does not exist`);
        continue;
      }
      const src = readFileSync(abs, "utf8");
      if (!verbSpans(src).some((s) => s.verb === verb)) problems.push(`${id}: no such verb`);
      if (reason.trim().length < 30) problems.push(`${id}: reason too short`);
      if (!nonAtomicHandlers(src, apiPath).includes(id)) problems.push(`${id}: is atomic now, remove it from EXCEPTIONS`);
    }
    expect(problems).toEqual([]);
  });

  it("the converted handlers really use the wrapper", () => {
    const users = files.filter((f) => /audited(?:Insert|Update|Delete)\s*\(/.test(readFileSync(f, "utf8"))).map(toApiPath);
    for (const expected of [
      "documents",
      "documents/[id]",
      "documents/[id]/file",
      "decisions/[id]",
      "projects/[id]/decisions",
      "invites",
      "invites/[id]/revoke",
      "invites/[id]/renew",
      "tokens",
      "tokens/[id]",
      "assistant/credentials",
      "me",
      "projects/[id]/budget",
      "integrations/identities/[id]",
    ]) {
      expect(users, expected).toContain(expected);
    }
  });

  it("secret-bearing tables never reach an audit row whole: the hash and ciphertext columns are omitted", () => {
    const src = (p: string) => readFileSync(join(API_DIR, p, "route.ts"), "utf8");
    expect(src("tokens")).toMatch(/omitColumns:\s*\["token_hash"\]/);
    expect(src("invites")).toMatch(/omitColumns:\s*\["token_hash"\]/);
    expect(src("assistant/credentials")).toMatch(/omitColumns:\s*\["api_key_enc"\]/);
  });

  it("the detector sees mutate-then-audit and ignores audit-then-mutate", () => {
    const bad = [
      "export const PATCH = route(async () => {",
      '  await db.from("documents").update({ a: 1 }).eq("id", 1);',
      '  await writeAudit({ action: "document.update" });',
      "});",
    ].join("\n");
    const good = [
      "export const PATCH = route(async () => {",
      '  await writeAudit({ action: "x.blocked" });',
      '  await db.from("documents").update({ a: 1 }).eq("id", 1);',
      "});",
    ].join("\n");
    expect(nonAtomicHandlers(bad, "documents/[id]")).toEqual(["documents/[id]#PATCH"]);
    expect(nonAtomicHandlers(good, "documents/[id]")).toEqual([]);
  });
});
