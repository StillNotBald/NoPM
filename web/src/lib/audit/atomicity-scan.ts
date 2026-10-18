/**
 * Text scan behind atomicity.test.ts (M1). Test support only: nothing in the app imports it.
 * Finds code that changes a table through the admin client and calls writeAudit( AFTER the
 * change, i.e. a change the trail can miss if the process dies in between.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function walkFiles(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, match, out);
    else if (match.test(entry.name)) out.push(p);
  }
  return out;
}

/** Offsets of `.from("t")...insert|update|delete|upsert(` chains. */
export function directWrites(src: string): { table: string; op: string; offset: number }[] {
  const out: { table: string; op: string; offset: number }[] = [];
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
    const op = src.slice(m.index, j).match(/\.(insert|update|delete|upsert)\(/)?.[1];
    if (op) out.push({ table: m[1], op, offset: m.index });
  }
  return out;
}

export function verbSpans(src: string): { verb: string; start: number; end: number }[] {
  const marks: { verb: string; at: number }[] = [];
  const re = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) marks.push({ verb: m[1], at: m.index });
  return marks.map((mk, i) => ({ verb: mk.verb, start: mk.at, end: marks[i + 1]?.at ?? src.length }));
}

/** "<id>#<VERB>" of every verb of a route file that calls writeAudit( after a direct write. */
export function nonAtomicHandlers(src: string, id: string): string[] {
  const writes = directWrites(src);
  const audits = [...src.matchAll(/writeAudit\s*\(/g)].map((m) => m.index as number);
  const bad: string[] = [];
  for (const span of verbSpans(src)) {
    const inSpan = writes.filter((w) => w.offset >= span.start && w.offset < span.end).map((w) => w.offset);
    if (inSpan.length === 0) continue;
    const earliest = Math.min(...inSpan);
    if (audits.some((a) => a > earliest && a < span.end)) bad.push(`${id}#${span.verb}`);
  }
  return bad;
}

/** True when a library file calls writeAudit( after a direct write on the admin client. */
export function libFileNonAtomic(src: string): boolean {
  const writes = directWrites(src).map((w) => w.offset);
  if (writes.length === 0) return false;
  const earliest = Math.min(...writes);
  return [...src.matchAll(/writeAudit\s*\(/g)].some((m) => (m.index as number) > earliest);
}
