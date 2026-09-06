import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Audit-coverage invariant test (R-83), modelled on
 * ../auth/workspace-isolation.test.ts.
 *
 * NoPM's constitution requires every mutation to produce exactly one
 * immutable audit_log row via writeAudit. This test walks every API route,
 * flags the ones with a mutating HTTP verb, and fails the build if a
 * mutating route neither calls writeAudit NOR is in the explicit ALLOWLIST
 * below with a reason. The allowlist is itself checked both ways: every
 * entry must point at a real route file that actually lacks a writeAudit
 * call (so the list can never grow stale in the "still needed" direction),
 * and if a route starts calling writeAudit it must be removed from the list
 * (checked by the same "actually lacks" assertion — a false allowlist entry
 * fails loudly instead of silently going unaudited-by-omission).
 */

const API_DIR = join(process.cwd(), "src", "app", "api");

// Every export style Next.js accepts for a route handler must be visible to
// this scan, or a route written in an unusual style would silently escape the
// invariant: `export const POST = route(...)`, `export async function POST()`,
// `export function POST()`, and re-exports like `export { handle as POST }`.
// All three styles already exist in this codebase (auth/*, mcp).
const MUTATING_VERB =
  /export\s+(?:const|async\s+function|function)\s+(?:POST|PATCH|PUT|DELETE)\b|\bas\s+(?:POST|PATCH|PUT|DELETE)\b/;

// A real function call, not just the word appearing in a comment (several
// routes explain in prose why they intentionally have none).
const WRITE_AUDIT_CALL = /writeAudit\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name === "route.ts") out.push(p);
  }
  return out;
}

function toApiPath(absPath: string): string {
  // Normalize to forward slashes and strip everything up to and including
  // "src/app/" so the map keys read exactly like the spec's `api/...` form.
  const normalized = absPath.replace(/\\/g, "/");
  const marker = "src/app/";
  const idx = normalized.indexOf(marker);
  const rel = idx >= 0 ? normalized.slice(idx + marker.length) : normalized;
  return rel.replace(/\/route\.ts$/, "");
}

// Explicit allowlist: route path (as it reads from src/app/, no /route.ts
// suffix) -> reason it legitimately has a mutating verb with no writeAudit
// call. Keep this list to exactly the routes named in the R-83 spec — do
// not pad it; any other flagged route must be audited instead.
const ALLOWLIST: Record<string, string> = {
  "api/deletion-requests/[id]/approve": "audited inside atomic RPC",
  "api/invites/accept": "audited inside RPC nopm_accept_invite",
  "api/auth/signout": "Supabase Auth session op, no workspace mutation",
  "api/auth/demo-login": "Supabase Auth session op, no workspace mutation",
  "api/notifications/[id]": "per-user read-state, ADR 0009 class",
  "api/notifications/read-all": "per-user read-state, ADR 0009 class",
  "api/documents/[id]/file/sign": "signed URL issuance, no row mutation",
  "api/reports/deck": "read that renders; scope audit:read",
  "api/reports/project/[id]": "read that renders; scope audit:read",
  "api/assistant/chat": "conversation persistence is per-user convenience; every tool call goes through the audited API",
  "api/mcp": "proxy; the target routes audit",
  "api/me/preferences": "ADR 0009 unaudited",
};

describe("audit-coverage invariant", () => {
  const routes = walk(API_DIR);

  it("finds the API route files", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("every allowlisted route exists and actually lacks a writeAudit call", () => {
    const problems: string[] = [];
    for (const [apiPath, reason] of Object.entries(ALLOWLIST)) {
      const abs = join(process.cwd(), "src", "app", apiPath, "route.ts");
      if (!existsSync(abs)) {
        problems.push(`${apiPath}: allowlisted route does not exist (reason on file: "${reason}")`);
        continue;
      }
      const src = readFileSync(abs, "utf8");
      if (WRITE_AUDIT_CALL.test(src)) {
        problems.push(`${apiPath}: allowlisted as unaudited ("${reason}") but now calls writeAudit — remove it from ALLOWLIST`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every mutating route calls writeAudit or is in the ALLOWLIST", () => {
    const violations: string[] = [];

    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      if (!MUTATING_VERB.test(src)) continue; // GET-only / no mutating verb

      if (WRITE_AUDIT_CALL.test(src)) continue; // audited

      const apiPath = toApiPath(file);
      if (Object.prototype.hasOwnProperty.call(ALLOWLIST, apiPath)) continue; // explicitly justified

      violations.push(apiPath);
    }

    expect(violations).toEqual([]);
  });
});

describe("BYOK credential audit hygiene", () => {
  const CREDENTIALS_ROUTE = join(API_DIR, "assistant", "credentials", "route.ts");

  it("finds the credentials route", () => {
    expect(existsSync(CREDENTIALS_ROUTE)).toBe(true);
  });

  it("never passes apiKey or api_key_enc into a writeAudit call", () => {
    const src = readFileSync(CREDENTIALS_ROUTE, "utf8");

    // Extract each writeAudit({...}) call body (balanced-enough for this
    // file's shape: no nested writeAudit calls) and assert the secret never
    // appears inside it.
    const calls: string[] = [];
    const callStart = /writeAudit\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = callStart.exec(src))) {
      const start = match.index + match[0].length - 1; // position of the opening "("
      let depth = 0;
      let end = start;
      for (let i = start; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      calls.push(src.slice(start, end + 1));
    }

    expect(calls.length).toBeGreaterThan(0); // sanity: PUT + DELETE both audit

    for (const call of calls) {
      expect(call).not.toMatch(/apiKey/);
      expect(call).not.toMatch(/api_key_enc/);
    }
  });
});
