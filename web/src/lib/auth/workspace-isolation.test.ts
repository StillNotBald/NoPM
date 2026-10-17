import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard test for the most dangerous silent-failure mode in NoPM:
 *
 * Token/agent callers use the service-role admin client (createAdminClient),
 * which BYPASSES RLS. Workspace isolation then depends entirely on every query
 * remembering to scope itself by workspace (actor.workspaceId). One unscoped
 * query would leak cross-tenant data with no DB-level catch.
 *
 * Two layers:
 *  1. Per-file (original): every API route using the admin client mentions a
 *     scoping token at least once. Cheap backstop.
 *  2. Per-CHAIN (A2-1, 2026-10-17): every `.from("t")` / `.rpc("fn")` chain in
 *     a file that uses the admin client must itself mention `workspace_id` or
 *     `workspaceId` (select/update/delete filter, insert payload, RPC arg) OR be
 *     listed in CHAIN_ALLOWLIST with a real reason. The allowlist is checked
 *     both ways: an entry that no longer matches an unscoped chain fails, so
 *     the list cannot go stale.
 *
 * Static parse, not a proof: a chain that mentions workspaceId in a comment or
 * a different clause would pass. It turns "one mention per file" into "no
 * query chain silently lacks a tenant predicate".
 */

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "app", "api");

const SCOPING_TOKENS = [
  "workspace_id",
  "workspaceId",
  "actor.id",
  "user.id",
  "user_id",
  "recipient_id",
  "profile_id",
];

function walkFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p, match));
    else if (match(entry.name)) out.push(p);
  }
  return out;
}

function walk(dir: string): string[] {
  return walkFiles(dir, (n) => n === "route.ts");
}

/** Production source files (no tests) under src/app and src/lib. */
function sourceFiles(): string[] {
  const isSrc = (n: string) => /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n);
  return [...walkFiles(join(SRC, "app"), isSrc), ...walkFiles(join(SRC, "lib"), isSrc)];
}

type Chain = { kind: "from" | "rpc"; name: string; text: string; line: number };

/** Every `.from("x")` / `.rpc("x")` call with the rest of its statement (to the `;` at depth 0). */
export function extractChains(src: string): Chain[] {
  const out: Chain[] = [];
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
    out.push({
      kind: m[1] as "from" | "rpc",
      name: m[2],
      text: src.slice(m.index, j),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

const WORKSPACE_PREDICATE = /workspace_id|workspaceId/;

const PER_USER = "per-user row (user_id / actor.id); no tenant data";
const RATE = "rate-limit counter RPC, key-scoped, no tenant data";
const CONV =
  "per-user/conversation: ownership verified (user_id = actor.id and workspace_id on the conversation lookup)";

/**
 * file (relative to src/, forward slashes) -> "from:table" | "rpc:fn" -> reason.
 * Source: A2 tenant-isolation audit, exceptions table (reviewed 2026-10-17).
 * Every entry covers ALL unscoped chains of that table in that file.
 */
const CHAIN_ALLOWLIST: Record<string, Record<string, string>> = {
  "app/api/assistant/chat/route.ts": {
    "from:assistant_messages": CONV,
    "from:assistant_conversations": CONV,
  },
  "app/api/assistant/conversations/[id]/route.ts": {
    "from:assistant_conversations": CONV,
    "from:assistant_messages": CONV,
  },
  "app/api/auth/mfa/challenge/route.ts": {
    "from:audit_log": "per-user read (actor_id = actor.id)",
    "from:user_mfa": PER_USER,
  },
  "app/api/auth/mfa/disable/route.ts": { "from:user_mfa": PER_USER },
  "app/api/auth/mfa/enroll/route.ts": { "from:user_mfa": PER_USER },
  "app/api/auth/mfa/route.ts": { "from:user_mfa": PER_USER },
  "app/api/auth/mfa/verify/route.ts": { "from:user_mfa": PER_USER },
  "app/api/calendar-feeds/route.ts": {
    "from:profiles": "indirect: ids come from workspace-filtered feed rows (created_by)",
  },
  "app/api/integrations/lark/[connectorId]/relay/route.ts": {
    "rpc:nopm_rate_check": RATE,
    "from:integration_connectors":
      "the connector row IS the workspace binding; the HMAC with its relay secret is verified next",
  },
  "app/api/invites/accept/route.ts": { "rpc:nopm_rate_check": RATE },
  "app/api/timesheet-submissions/route.ts": {
    "from:timesheet_submissions":
      "indirect: member_id was just verified in this workspace (resource_members + workspace filter); uuid is globally unique",
  },
  "app/invite/[token]/page.tsx": {
    "from:profiles": "inviter named on the invite itself, shown to the token holder by design",
  },
  "lib/audit/write.ts": {
    "from:audit_log": "insert payload object is built just above with workspace_id: input.workspaceId (variable, so the chain text lacks the token)",
  },
  "lib/api/rate-limit.ts": { "rpc:nopm_rate_check": RATE },
  "lib/assistant/index.ts": {
    "rpc:nopm_demo_rate_check": RATE,
    "from:assistant_credentials": CONV,
    "from:assistant_demo_usage": "per-user demo quota row (user_id filter)",
    "rpc:nopm_rate_check": RATE,
  },
  "lib/assistant/token.ts": { "from:api_tokens": CONV },
  "lib/auth/demo.ts": { "from:profiles": "per-user lookup (actor.id)" },
  "lib/auth/guard.ts": {
    "rpc:nopm_rate_check": RATE,
    "from:api_tokens": "update by the token id just resolved from the sha-256 hash lookup (last_used_at)",
  },
  "lib/auth/mfa.ts": { "from:user_mfa": PER_USER },
  "lib/auth/mfa-factor.ts": { "from:user_mfa": PER_USER, "rpc:nopm_rate_check": RATE },
  "lib/integrations/cron.ts": {
    "from:integration_connectors": "global by design: cron iterates every active connector, then works under connector.workspace_id",
    "from:integration_cron_state": "global by design: cron state per connector",
    "from:integration_deliveries": "indirect: connector ids come from the cron page",
    "rpc:nopm_purge_idempotency_keys": "global by design: deletes only expired Idempotency-Key bookkeeping rows (migration 0074), reads nothing back",
  },
  "lib/integrations/identity.ts": { "rpc:nopm_rate_check": RATE },
  "lib/integrations/lark/wiring.ts": {
    "from:integration_connectors":
      "the connector row IS the workspace binding (webhook URL carries only the connector uuid); secrets are verified next",
    "rpc:nopm_rate_check": RATE,
  },
  "lib/notify/publish.ts": {
    "from:notifications":
      "rows are built with workspace_id; recipients re-checked against profiles of that workspace before the insert",
  },
};

describe("workspace isolation (admin-client scoping)", () => {
  const routes = walk(API_DIR);

  it("finds the API route files", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("every admin-client route scopes by workspace or caller identity", () => {
    const adminRoutes = routes.filter((f) => readFileSync(f, "utf8").includes("createAdminClient"));
    expect(adminRoutes.length).toBeGreaterThan(20); // sanity: most routes use it

    const unscoped = adminRoutes.filter((f) => {
      const src = readFileSync(f, "utf8");
      return !SCOPING_TOKENS.some((t) => src.includes(t));
    });

    expect(unscoped.map((f) => f.replace(API_DIR, "api"))).toEqual([]);
  });
});

describe("workspace isolation (per query chain, A2-1)", () => {
  const files = sourceFiles().filter((f) => readFileSync(f, "utf8").includes("createAdminClient"));
  const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, "/");

  /** file -> set of "kind:name" keys that have at least one chain without a workspace predicate. */
  const unscoped = new Map<string, Map<string, number[]>>();
  let total = 0;
  for (const f of files) {
    for (const c of extractChains(readFileSync(f, "utf8"))) {
      total++;
      if (WORKSPACE_PREDICATE.test(c.text)) continue;
      const key = `${c.kind}:${c.name}`;
      const byKey = unscoped.get(rel(f)) ?? new Map<string, number[]>();
      byKey.set(key, [...(byKey.get(key) ?? []), c.line]);
      unscoped.set(rel(f), byKey);
    }
  }

  it("parses a realistic number of chains", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(total).toBeGreaterThan(300);
  });

  it("every query chain carries a workspace predicate or is allowlisted with a reason", () => {
    const violations: string[] = [];
    for (const [file, byKey] of unscoped) {
      for (const [key, lines] of byKey) {
        if (!CHAIN_ALLOWLIST[file]?.[key]) violations.push(`${file}:${lines.join(",")} ${key}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("every allowlist entry has a real reason and still matches an unscoped chain", () => {
    const problems: string[] = [];
    for (const [file, entries] of Object.entries(CHAIN_ALLOWLIST)) {
      for (const [key, reason] of Object.entries(entries)) {
        if (reason.trim().length < 20) problems.push(`${file} ${key}: reason too short`);
        if (!unscoped.get(file)?.has(key)) {
          problems.push(`${file} ${key}: stale (chain now scoped, or file/query gone) - remove it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("the parser flags an unscoped chain and accepts a scoped one", () => {
    const bad = extractChains(`await admin.from("tasks").select("*").eq("id", id).single();`);
    const good = extractChains(
      `await admin.from("tasks").select("*").eq("id", id).eq("workspace_id", actor.workspaceId).single();`,
    );
    expect(WORKSPACE_PREDICATE.test(bad[0].text)).toBe(false);
    expect(WORKSPACE_PREDICATE.test(good[0].text)).toBe(true);
  });
});
