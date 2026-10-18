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
// M1: the atomic wrapper (audited-write.ts) writes the audit row inside the same
// transaction as the mutation, so a call to it counts exactly like writeAudit(.
const WRITE_AUDIT_CALL = /(?:writeAudit|auditedInsert|auditedUpdate|auditedDelete)\s*\(/;

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
// A3-18: ADR 0009 covers appearance preferences (user_preferences) only. Notification read
// state is a separate case: per-recipient inbox bookkeeping (read_at on rows whose governed
// event was already audited when it was published); it changes no governed entity and
// reaches no other user. If an ADR is written for it, cite that instead.
const NOTIFICATION_READ_STATE =
  "per-recipient inbox read_at bookkeeping on a row whose governed event was already audited; changes no governed entity (not covered by ADR 0009, which is appearance preferences only)";

const MEMBER_RPC_AUDIT =
  "audited inside the SQL RPC (nopm_member_change / nopm_member_mfa_reset, migration 0083) called through lib/people/members.ts, in the same transaction as the change";

const ALLOWLIST: Record<string, string> = {
  "api/openapi.json": "documentation route: GET only, no database access; its text quotes route verbs and audit calls, which the scanner must not read as handlers",
  "api/members/[id]": MEMBER_RPC_AUDIT,
  "api/members/[id]/restore": MEMBER_RPC_AUDIT,
  "api/members/[id]/mfa-reset": MEMBER_RPC_AUDIT,
  "api/deletion-requests/[id]/approve": "audited inside atomic RPC",
  "api/expenses/[id]": "DELETE only raises a deletion request through requestDeletion() (lib/governance/request-deletion.ts), which writes expense.delete_requested; the delete itself is audited inside nopm_commit_expense_deletion (migration 0102)",
  "api/invites/accept": "audited inside RPC nopm_accept_invite",
  "api/auth/demo-login": "Supabase Auth session op, no workspace mutation",
  "api/notifications/[id]": NOTIFICATION_READ_STATE,
  "api/notifications/read-all": NOTIFICATION_READ_STATE,
  "api/documents/[id]/file/sign": "signed URL issuance, no row mutation",
  "api/reports/weekly": "audited inside generateWeeklyReport (report.weekly.generated), which stores the snapshot and writes the row before anyone is notified",
  "api/reports/deck": "read that renders; scopes audit:read + budget:read (budget figures in the output)",
  "api/reports/project/[id]": "read that renders; scopes audit:read + budget:read (budget figures in the output)",
  "api/assistant/chat": "conversation persistence is per-user convenience; every tool call goes through the audited API",
  "api/mcp": "proxy; the target routes audit",
  "api/me/preferences": "appearance preferences are non-governance state, unaudited by ADR 0009",
  "api/integrations/connectors/[id]/test": "read-style credential probe: asks the chat platform for the bot's own info and writes no NoPM row (asserted in actions.test.ts)",
  "api/integrations/lark/[connectorId]/card": "card.action.trigger: the only mutation is a human approve/reject: handleApprovalAction (inbound.ts) -> decideApproval (decide.ts) -> approveDeletion (audited inside the nopm_commit_*_deletion RPC) | rejectDeletion | decideChangeRequest | decideTimesheet, each with its own writeAudit; channel 'lark'",
  "api/integrations/lark/[connectorId]/events": "chat event webhook: url_verification and the help/approvals/unknown DM replies write nothing; a card.action.trigger delegates to the card route; 'link <code>' -> identity.ts consumeLinkCode writes integration.identity.link for a NEW link. Open gap: re-confirming an already-linked account burns the code with no audit row",
  "api/integrations/github/[connectorId]/events": "GitHub webhook: verifies the HMAC signature, then lib/integrations/github/process.ts records the event in work_events (bookkeeping, not governed data) and moves a linked task through lib/work/apply-task-status.ts, which writes the task.update audit row as the connector actor (channel 'github'); a task on a locked project gets work_event.skipped; ping and unsupported events write nothing; its only other DB write is the nopm_rate_check counter",
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
};

/**
 * Wave 5 (R-163..R-165): modules whose every database call is a SQL function that writes its own audit row
 * through nopm_audit_insert. A route that imports one of them is audited by that function, not by a
 * writeAudit( in the route. This is a checked rule, not an allowlist: the test "every RPC named in an
 * audited-RPC module audits inside its latest SQL definition" fails if any function in these files stops
 * auditing, so importing the module can never hide an unaudited write.
 */
const AUDITED_RPC_MODULES: { file: string; importPattern: RegExp }[] = [
  { file: join("src", "lib", "governance", "atomic-rpc.ts"), importPattern: /from\s+["']@\/lib\/governance\/atomic-rpc["']/ },
  { file: join("src", "app", "api", "auth", "mfa", "_rpc.ts"), importPattern: /from\s+["']\.\.\/_rpc["']/ },
];

/** Names of the nopm_* database functions a module calls (quoted literals, which also covers helper-style calls). */
function moduleRpcNames(fileRel: string): string[] {
  const src = readFileSync(join(process.cwd(), fileRel), "utf8");
  return [...new Set([...src.matchAll(/["'`](nopm_\w+)["'`]/g)].map((m) => m[1]))];
}

/** Function names a route imports from an audited-RPC module. */
function auditedModuleImports(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*(from\s+["'][^"']+["'])/g)) {
    if (!AUDITED_RPC_MODULES.some((mod) => mod.importPattern.test(m[2]))) continue;
    for (const part of m[1].split(",")) {
      const local = part.trim().split(/\s+as\s+/).pop();
      if (local && !/^type\s/.test(part.trim())) names.push(local);
    }
  }
  return names;
}

/**
 * W1-01: a handler span is covered by an audited-RPC module only when it calls at least one imported module
 * function AND contains no other mutating call: no direct .from(...).insert|update|delete|upsert( on a governed
 * table and no .rpc( that is not audited in SQL. One RPC call followed by a direct update fails.
 */
function handlerCoveredByModule(span: string, imported: string[]): boolean {
  if (!imported.some((n) => new RegExp(String.raw`\b${n}\s*\(`).test(span))) return false;
  return findWrites(span).filter(isGoverned).every((w) => w.rpc && rpcAuditsInSql(w.table) === true);
}

/** Every POST/PATCH/PUT/DELETE handler audits itself (writeAudit / audited RPC) or is covered by a module. */
function everyMutatingHandlerAudited(src: string): boolean {
  const imported = auditedModuleImports(src);
  if (imported.length === 0) return false;
  const spans = verbSpans(src).filter((sp) => sp.verb !== "GET");
  if (spans.length === 0) return false;
  return spans.every((sp) => {
    const body = src.slice(sp.start, sp.end);
    return (
      handlerCoveredByModule(body, imported) ||
      WRITE_AUDIT_CALL.test(body) ||
      [...body.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].some((m) => rpcAuditsInSql(m[1]) === true)
    );
  });
}

/** RPC names called by one exported function of atomic-rpc.ts (the wrapper a delegate follows into). */
function atomicWrapperRpcs(fn: string): string[] {
  const src = readFileSync(join(process.cwd(), "src", "lib", "governance", "atomic-rpc.ts"), "utf8");
  const start = src.search(new RegExp(String.raw`export\s+(?:async\s+)?function\s+${fn}\s*\(`));
  if (start < 0) return [];
  const rest = src.slice(start + 1);
  const next = rest.search(/\nexport\s/);
  const body = next < 0 ? rest : rest.slice(0, next);
  return [...body.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
}

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
      // audited atomically inside a SQL RPC (latest definition inserts into audit_log)
      if ([...src.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].some((m) => rpcAuditsInSql(m[1]) === true)) continue;

      // audited through an audited-RPC module (atomic-rpc.ts, mfa/_rpc.ts), PER HANDLER: every mutating
      // handler of the file must be covered by the module (or audit by itself). The module is verified below.
      if (everyMutatingHandlerAudited(src)) continue;

      const apiPath = toApiPath(file);
      if (Object.prototype.hasOwnProperty.call(ALLOWLIST, apiPath)) continue; // explicitly justified
      if (Object.prototype.hasOwnProperty.call(DELEGATED_AUDIT, apiPath)) continue; // audited in decide.ts — verified below

      violations.push(apiPath);
    }

    expect(violations).toEqual([]);
  });
});

describe("W1-01 per-handler module rule and W1-02 SQL scan (negative fixtures)", () => {
  const imp = ["rejectDeletionAtomic"];
  it("a handler with one module call and a later direct write is NOT covered", () => {
    const bad = 'export const PATCH = route(async () => { await rejectDeletionAtomic(db, a); await db.from("tasks").update({ x: 1 }).eq("id", 1); });';
    expect(handlerCoveredByModule(bad, imp)).toBe(false);
  });
  it("a handler that only calls the module is covered; one that never calls it is not", () => {
    expect(handlerCoveredByModule('export const DELETE = route(async () => { await rejectDeletionAtomic(db, a); });', imp)).toBe(true);
    expect(handlerCoveredByModule('export const PATCH = route(async () => { await db.from("tasks").update({}); });', imp)).toBe(false);
  });
  it("a file whose PATCH is unaudited stays a violation even though its DELETE uses the module", () => {
    const src = [
      'import { rejectDeletionAtomic } from "@/lib/governance/atomic-rpc";',
      'export const PATCH = route(async () => { await db.from("tasks").update({}); });',
      'export const DELETE = route(async () => { await rejectDeletionAtomic(db, a); });',
    ].join("\n");
    expect(everyMutatingHandlerAudited(src)).toBe(false);
  });
  it("SQL: comments, dead branches and the exception path do not count", () => {
    expect(sqlBodyAudits("begin\n  -- perform nopm_audit_insert(a);\n  update t set x = 1;\nend")).toBe(false);
    expect(sqlBodyAudits("begin\n  /* perform nopm_audit_insert(a); */\n  update t set x = 1;\nend")).toBe(false);
    expect(sqlBodyAudits("begin\n  if false then\n    perform nopm_audit_insert(a);\n  end if;\nend")).toBe(false);
    expect(sqlBodyAudits("begin\n  update t set x = 1;\nexception when others then\n  perform nopm_audit_insert(a);\nend")).toBe(false);
    expect(sqlBodyAudits("begin\n  update t set x = 1;\n  perform nopm_audit_insert(a);\nend")).toBe(true);
    expect(sqlBodyAudits("begin\n  insert into audit_log (x) values (1);\nend")).toBe(true);
  });
});

describe("audited-RPC modules", () => {
  for (const m of AUDITED_RPC_MODULES) {
    it(`every RPC named in ${m.file.split("\\").join("/")} audits inside its latest SQL definition`, () => {
      const names = moduleRpcNames(m.file);
      expect(names.length).toBeGreaterThan(0);
      const bad = names.filter((n) => NON_MUTATING_RPC[n] === undefined && rpcAuditsInSql(n) !== true);
      expect(bad).toEqual([]);
    });
  }
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

      it("the delegate audits exactly once: one writeAudit( call, or (RPC style) none and one RPC whose SQL inserts the audit row", () => {
        const body = decideFunctionSource(fn);
        expect(body, `${fn} not found in decide.ts`).not.toBeNull();
        const calls = (body as string).match(/writeAudit\s*\(/g) ?? [];
        if (calls.length === 1) return;
        expect(calls.length).toBe(0);
        const direct = [...(body as string).matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
        // wave 5: the function may call a wrapper in atomic-rpc.ts (rejectDeletionAtomic ...); follow it to its RPC
        const followed = [...(body as string).matchAll(/\b(\w+Atomic)\s*\(/g)].flatMap((m) => atomicWrapperRpcs(m[1]));
        const rpcs = [...direct, ...followed];
        expect(rpcs.filter((r) => rpcAuditsInSql(r) === true).length, `${fn}: no audited RPC`).toBe(1);
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
    const callStart = /(?:writeAudit|auditedInsert|auditedUpdate|auditedDelete)\s*\(/g;
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
      if (/^\(\s*\{\s*table:/.test(call)) {
        // Atomic wrapper (M1): the ciphertext is the WRITTEN patch, so the guarantee is that the
        // column is omitted from the audit row and the returned row, and that the explicit
        // audit payloads carry provider and model only.
        expect(call).toMatch(/omitColumns:\s*\["api_key_enc"\]/);
        for (const payload of call.match(/audit(?:Before|After):\s*(?:\{[^}]*\}|[a-z]+)/g) ?? []) {
          expect(payload).not.toMatch(/apiKey|api_key_enc/);
        }
      } else {
        expect(call).not.toMatch(/apiKey/);
        expect(call).not.toMatch(/api_key_enc/);
      }
    }
  });
});

/* ------------------------------------------------------------------------- *
 * A3-9 (2026-10-17): write paths the verb-level check above cannot see.
 *
 *  1. PER-VERB: a route file with one writeAudit call used to pass even if a
 *     second verb (or a GET) wrote without auditing. Each exported verb's own
 *     span must audit if it writes a business table.
 *  2. GET handlers that write are included (feed fetch, cron).
 *  3. Library writers under src/lib that mutate business tables must audit in
 *     the file, or be listed with a real reason.
 *  4. Mutating RPCs must audit inside the SQL function (checked against the
 *     latest migration that defines it).
 * ------------------------------------------------------------------------- */

const SRC_DIR = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** Tables whose rows are not governed business data. Every entry needs a reason. */
const NON_BUSINESS_TABLES: Record<string, string> = {
  audit_log: "the audit trail itself",
  idempotency_keys: "request replay cache; the replayed mutation is audited by its own handler",
  notifications: "derived inbox rows fanned out from already-audited governed events",
  assistant_conversations: "per-user chat persistence; every tool call goes through the audited API",
  assistant_messages: "per-user chat persistence; every tool call goes through the audited API",
  user_preferences: "appearance preferences, unaudited by ADR 0009",
  user_mfa: "per-user MFA state; enroll/enable/disable/challenge are audited via writeAudit in the mfa routes",
  inbound_actions: "idempotency/claim ledger for connector events; the resulting decision is audited by decide.ts",
  action_tokens: "single-use button tokens for connector cards; the resulting decision is audited by decide.ts",
  integration_deliveries:
    "outbound delivery queue/status; egress itself is audited when queued (integration.digest.send etc.)",
};

/** RPCs that do not mutate governed data. */
const NON_MUTATING_RPC: Record<string, string> = {
  nopm_rate_check: "rate-limit counter",
  nopm_demo_rate_check: "rate-limit counter",
  nopm_next_ref: "reference-number allocator; the creating handler audits the new row",
  nopm_project_child_counts: "read-only count",
  nopm_rate_peek: "rate-limit counter read",
  nopm_demo_rate_refund: "gives back a failed shared-demo turn to the per-user rate counter; bookkeeping, not a governed table",
  nopm_auth_user_for_invite: "read-only lookup of an auth user by invite email",
  nopm_revoke_user_sessions:
    "ends a removed member's sign-in sessions (auth schema, not a governed table); the removal itself is audited as member.remove inside nopm_member_change",
};

/** Files (path under src/) that write business tables with no writeAudit, each with a real reason. */
const UNAUDITED_WRITER_ALLOWLIST: Record<string, string> = {
  "lib/audit/anchor/receipts.ts":
    "bookkeeping of the external-anchor state per workspace (display and streak memory only, never evidence; the evidence is the anchor database); each state change carries its own audit row (audit.anchored, audit.anchor_failed, audit.anchor_mismatch) written by anchor/step.ts and the verify route (R-168..R-170)",
  "app/api/calendar/[token]/route.ts":
    "GET feed fetch stamps calendar_feeds.last_fetched_at (read telemetry on the creator's own feed); no governed field changes",
  "lib/auth/guard.ts": "stamps api_tokens.last_used_at on use; telemetry, not a governed change",
  "lib/integrations/github/process.ts":
    "bookkeeping ledger of received GitHub events (work_events); the only governed change it triggers, a task status move, is made by nopm_apply_task_status_from_event (lib/work/apply-task-status.ts), which writes the task.update or work_event.skipped audit row in the same transaction",
  "lib/integrations/identity.ts":
    "mintLinkCode inserts and deletes identity_link_codes rows: minting a short-lived link code is not a governed change; the link itself is audited inside nopm_link_identity (migration 0109)",
  "lib/governance/approval-events.ts":
    "bookkeeping ledger of what the daily approval timer did (reminder, escalation, overdue flag); the governed facts it describes carry their own audit rows and the timer writes one approval.timer_run row per workspace per run",
};

function relSrc(abs: string): string {
  return abs.slice(SRC_DIR.length + 1).replace(/\\/g, "/");
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkSrc(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

type Write = { table: string; op: string; rpc: boolean; offset: number };

/** Every `.from("t").insert|update|delete|upsert` and `.rpc("fn")` in a source string. */
function findWrites(src: string): Write[] {
  const out: Write[] = [];
  const re = /\.(from|rpc)\(\s*["'`](\w+)["'`]/g;
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
    const text = src.slice(m.index, j);
    if (m[1] === "rpc") out.push({ table: m[2], op: "rpc", rpc: true, offset: m.index });
    else {
      const op = text.match(/\.(insert|update|delete|upsert)\(/)?.[1];
      if (op) out.push({ table: m[2], op, rpc: false, offset: m.index });
    }
  }
  return out;
}

/** [verb, start, end) spans of exported handlers in a route file. */
function verbSpans(src: string): { verb: string; start: number; end: number }[] {
  const marks: { verb: string; at: number }[] = [];
  const re = /export\s+(?:const|async\s+function|function)\s+(GET|POST|PATCH|PUT|DELETE)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) marks.push({ verb: m[1], at: m.index });
  return marks.map((mk, i) => ({ verb: mk.verb, start: mk.at, end: marks[i + 1]?.at ?? src.length }));
}

const AUDIT_CALL = WRITE_AUDIT_CALL;

/** true/false = the latest SQL definition of `fn` does/doesn't insert into audit_log; null = no definition found. */
function rpcAuditsInSql(fn: string): boolean | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let latest: string | null = null;
  const def = new RegExp(String.raw`create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?${fn}\s*\(`, "i");
  for (const f of files) {
    const t = readFileSync(join(MIGRATIONS, f), "utf8");
    const at = t.search(def);
    if (at >= 0) {
      const rest = t.slice(at);
      const end = rest.search(/\n\$[a-z_]*\$\s*;/i);
      latest = end < 0 ? rest : rest.slice(0, end);
    }
  }
  return latest === null ? null : sqlBodyAudits(latest);
}

/** SQL without -- line comments and block comments, so a commented-out call never counts. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

/**
 * W1-02: a function audits when, after comments are stripped, it holds a statement-level
 * insert into audit_log or perform|select nopm_audit_insert( that can run: not inside a branch whose condition is
 * literally false/null (if false then ... end if), and not inside the function's own exception handler
 * (an exception when at the top level of the body). Calls inside ordinary conditional branches count, because
 * wave 5 functions audit per operation (create, update, revoke).
 */
function sqlBodyAudits(sql: string): boolean {
  const body = stripSqlComments(sql);
  const tok = /\bend\s+(?:if|loop|case)\b|\bexception\s+when\b|\bif\b([\s\S]*?)\bthen\b|\bloop\b|(?:^|[;\s])(?:perform|select)\s+(?:public\.)?nopm_audit_insert\s*\(|insert\s+into\s+(?:public\.)?audit_log\b/gi;
  const dead = /^\s*(?:not\s+true|false|null|0\s*=\s*1|1\s*=\s*0)\s*$/i;
  const stack: boolean[] = []; // true = dead branch
  let m: RegExpExecArray | null;
  while ((m = tok.exec(body))) {
    const t = m[0].toLowerCase().trim();
    if (/^end\s/.test(t)) stack.pop();
    else if (t.startsWith("exception")) {
      if (stack.length === 0) return false; // top-level handler: the rest is the error path
    } else if (t === "loop") stack.push(false);
    else if (/^if\b/.test(t)) stack.push(dead.test(m[1] ?? ""));
    else if (!stack.includes(true)) return true; // statement-level audit call that can run
  }
  return false;
}

const isGoverned = (w: Write) => (w.rpc ? !NON_MUTATING_RPC[w.table] : !NON_BUSINESS_TABLES[w.table]);

describe("A3-9: per-verb, GET, library and RPC write coverage", () => {
  const files = walkSrc(SRC_DIR);
  const routeFiles = files.filter((x) => x.endsWith("route.ts") && relSrc(x).startsWith("app/api/"));

  it("every verb (GET included) that writes a governed table audits within its own handler", () => {
    const problems: string[] = [];
    for (const f of routeFiles) {
      const src = readFileSync(f, "utf8");
      const rel = relSrc(f);
      const apiPath = toApiPath(f);
      if (ALLOWLIST[apiPath] || DELEGATED_AUDIT[apiPath] || UNAUDITED_WRITER_ALLOWLIST[rel]) continue;
      const spans = verbSpans(src);
      for (const w of findWrites(src).filter(isGoverned)) {
        const span = spans.find((s) => w.offset >= s.start && w.offset < s.end);
        // a write before the first verb lives in a file-level helper: the whole file must audit
        const body = span ? src.slice(span.start, span.end) : src;
        if (!AUDIT_CALL.test(body) && !(w.rpc && rpcAuditsInSql(w.table))) {
          problems.push(`${rel}: ${span?.verb ?? "helper"} writes ${w.table} (${w.op}) with no writeAudit in its handler`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the scan really sees GET handlers that write", () => {
    const getWriters = routeFiles.filter((f) => {
      const src = readFileSync(f, "utf8");
      return verbSpans(src).some(
        (s) => s.verb === "GET" && findWrites(src).some((w) => w.offset >= s.start && w.offset < s.end),
      );
    });
    expect(getWriters.map(relSrc)).toContain("app/api/calendar/[token]/route.ts");
  });

  it("detects an unaudited second verb in a file that audits one verb (regression for the file-level hole)", () => {
    const src = [
      'export const POST = route(async () => { await db.from("tasks").insert({}); await writeAudit({}); });',
      'export const DELETE = route(async () => { await db.from("tasks").delete().eq("id", 1); });',
    ].join("\n");
    const spans = verbSpans(src);
    const bad = findWrites(src).filter((w) => {
      const s = spans.find((x) => w.offset >= x.start && w.offset < x.end)!;
      return !AUDIT_CALL.test(src.slice(s.start, s.end));
    });
    expect(bad.map((w) => `${w.table}:${w.op}`)).toEqual(["tasks:delete"]);
  });

  it("library writers of governed tables audit in-file or are allowlisted with a reason", () => {
    const problems: string[] = [];
    for (const f of files.filter((x) => relSrc(x).startsWith("lib/"))) {
      const rel = relSrc(f);
      const src = readFileSync(f, "utf8");
      const writes = findWrites(src).filter(isGoverned);
      if (writes.length === 0 || AUDIT_CALL.test(src) || UNAUDITED_WRITER_ALLOWLIST[rel]) continue;
      for (const w of writes) {
        if (w.rpc && rpcAuditsInSql(w.table)) continue; // audited inside the SQL function
        problems.push(`${rel}: writes ${w.table} (${w.op}) with no writeAudit and no allowlist reason`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("a mutating RPC is audited inside its latest SQL definition, or by writeAudit in every file that calls it", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const w of findWrites(src).filter((x) => x.rpc && isGoverned(x))) {
        seen++;
        if (rpcAuditsInSql(w.table) !== true && !AUDIT_CALL.test(src)) {
          problems.push(`${relSrc(f)}: rpc ${w.table} is neither audited in SQL nor followed by writeAudit in the caller`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("allowlist entries have real reasons and are still needed (A3-18)", () => {
    const problems: string[] = [];
    for (const [rel, reason] of Object.entries(UNAUDITED_WRITER_ALLOWLIST)) {
      const abs = join(SRC_DIR, rel);
      if (!existsSync(abs)) {
        problems.push(`${rel}: file does not exist`);
        continue;
      }
      if (AUDIT_CALL.test(readFileSync(abs, "utf8"))) problems.push(`${rel}: now calls writeAudit - remove it from the allowlist`);
      if (reason.trim().length < 30) problems.push(`${rel}: reason too short`);
    }
    for (const [name, reason] of [
      ...Object.entries(NON_BUSINESS_TABLES),
      ...Object.entries(NON_MUTATING_RPC),
      ...Object.entries(ALLOWLIST),
    ]) {
      if (reason.trim().length < 15) problems.push(`${name}: reason too short`);
    }
    expect(problems).toEqual([]);
    // ADR 0009 is appearance preferences only; it must not be cited for notification read state.
    for (const k of ["api/notifications/[id]", "api/notifications/read-all"]) {
      expect(ALLOWLIST[k]).not.toMatch(/ADR 0009 class/);
    }
  });
});
