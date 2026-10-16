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
  "api/reports/deck": "read that renders; scopes audit:read + budget:read (budget figures in the output)",
  "api/reports/project/[id]": "read that renders; scopes audit:read + budget:read (budget figures in the output)",
  "api/assistant/chat": "conversation persistence is per-user convenience; every tool call goes through the audited API",
  "api/mcp": "proxy; the target routes audit",
  "api/me/preferences": "ADR 0009 unaudited",
  "api/integrations/connectors/[id]/test": "read-style credential probe: asks the chat platform for the bot's own info and writes no NoPM row (asserted in actions.test.ts)",
  "api/integrations/lark/[connectorId]/card": "card.action.trigger: the only mutation is a human approve/reject: handleApprovalAction (inbound.ts) -> decideApproval (decide.ts) -> approveDeletion (audited inside the nopm_commit_*_deletion RPC) | rejectDeletion | decideChangeRequest | decideTimesheet, each with its own writeAudit; channel 'lark'",
  "api/integrations/lark/[connectorId]/events": "chat event webhook: url_verification and the help/approvals/unknown DM replies write nothing; a card.action.trigger delegates to the card route; 'link <code>' -> identity.ts consumeLinkCode writes integration.identity.link for a NEW link. Open gap: re-confirming an already-linked account burns the code with no audit row",
  "api/integrations/lark/[connectorId]/relay": "self-host relay: verifies the HMAC, then runs the same handleLarkPayload as the webhook routes, so the audit row is the one named for those routes (card -> decide.ts; link -> identity.ts); its only DB write is the nopm_rate_check counter",
};

/**
 * Routes that are thin wrappers over a governed decision function in
 * src/lib/governance/decide.ts (2026-10-16): one code path for the console,
 * CLI, MCP and chat connectors, so the audit row is written THERE, not in the
 * route. This is a narrower, checked mechanism — NOT an allowlist of
 * unaudited routes: each entry must (a) call the named function from
 * @/lib/governance/decide, (b) carry NO writeAudit( of its own (so the
 * mutation can never be audited twice), and (c) name a function whose body
 * contains exactly ONE writeAudit( call. A route that stops delegating, or a
 * delegate that loses (or doubles) its audit call, fails the build.
 */
const DELEGATED_AUDIT: Record<string, { fn: string; reason: string }> = {
  "api/deletion-requests/[id]/reject": {
    fn: "rejectDeletion",
    reason: "decision logic + 'deletion_request.rejected' audit live in decide.ts",
  },
  "api/deletion-requests/[id]/withdraw": {
    fn: "withdrawDeletion",
    reason: "decision logic + 'deletion_request.withdrawn' audit live in decide.ts",
  },
  "api/change-requests/[id]/decision": {
    fn: "decideChangeRequest",
    reason: "decision logic + 'change_request.decide' audit live in decide.ts",
  },
  "api/timesheet-submissions/[id]/decision": {
    fn: "decideTimesheet",
    reason: "decision logic + 'timesheet.approved|rejected|reopened' audit live in decide.ts",
  },
};

const DECIDE_TS = join(process.cwd(), "src", "lib", "governance", "decide.ts");

/** Source of one top-level exported function in decide.ts, up to the next top-level declaration. */
function decideFunctionSource(fn: string): string | null {
  const src = readFileSync(DECIDE_TS, "utf8");
  const start = src.indexOf(`export async function ${fn}(`);
  if (start < 0) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:export |async function |function |type |const |\/\/ ──)/);
  return next < 0 ? rest : rest.slice(0, next);
}

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
      if (Object.prototype.hasOwnProperty.call(DELEGATED_AUDIT, apiPath)) continue; // audited in decide.ts — verified below

      violations.push(apiPath);
    }

    expect(violations).toEqual([]);
  });
});

describe("audit delegation to governance/decide.ts", () => {
  it("a delegated route is never also allowlisted as unaudited", () => {
    for (const apiPath of Object.keys(DELEGATED_AUDIT)) {
      expect(Object.prototype.hasOwnProperty.call(ALLOWLIST, apiPath), apiPath).toBe(false);
    }
  });

  for (const [apiPath, { fn, reason }] of Object.entries(DELEGATED_AUDIT)) {
    describe(`${apiPath} -> ${fn} (${reason})`, () => {
      const abs = join(process.cwd(), "src", "app", apiPath, "route.ts");

      it("is a real mutating route", () => {
        expect(existsSync(abs)).toBe(true);
        expect(MUTATING_VERB.test(readFileSync(abs, "utf8"))).toBe(true);
      });

      it("calls the delegate imported from @/lib/governance/decide", () => {
        const src = readFileSync(abs, "utf8");
        expect(src).toMatch(/from "@\/lib\/governance\/decide"/);
        expect(src).toMatch(new RegExp(String.raw`\b${fn}\s*\(`));
      });

      it("has no writeAudit( of its own (exactly one audit row, written by the delegate)", () => {
        expect(WRITE_AUDIT_CALL.test(readFileSync(abs, "utf8"))).toBe(false);
      });

      it("the delegate's body contains exactly one writeAudit( call", () => {
        const body = decideFunctionSource(fn);
        expect(body, `${fn} not found in decide.ts`).not.toBeNull();
        const calls = (body as string).match(/writeAudit\s*\(/g) ?? [];
        expect(calls.length).toBe(1);
      });
    });
  }
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
