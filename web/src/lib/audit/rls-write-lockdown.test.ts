/**
 * RLS write lockdown — "the API is the only writer" (migration 0048), drift test.
 *
 * The constitution says every mutation goes through an audited API route
 * (one immutable audit_log row, plus the scope / lock / four-eyes checks in
 * route code and RPCs). Early migrations also gave every non-viewer a
 * `for all` write policy on the domain tables, so a signed-in member could
 * skip all of that by calling Supabase's REST endpoint with the public anon
 * key + their own session JWT. Migration 20261016000048_rls_api_only_writes.sql
 * closes the hole; THIS suite keeps it closed.
 *
 * There is no live Postgres in this suite, so — same source-text approach as
 * rpc-provenance.test.ts — it replays every migration in filename order
 * (a deliberately small SQL reader: CREATE TABLE, ENABLE RLS, CREATE/DROP
 * POLICY including the `do $$ foreach t in array ... execute format(...)`
 * loops the early migrations use, and GRANT/REVOKE on tables) and asserts the
 * FINAL state:
 *
 *   1. no table has a non-select policy unless it is on the explicit
 *      user-owned allow-list (profiles, notifications) — so a NEW table with a
 *      careless `for all` policy fails here the day it is written;
 *   2. no governed table grants INSERT/UPDATE/DELETE to anon/authenticated;
 *   3. every governed table keeps its read policy (the lockdown must not
 *      break the console's session-client reads);
 *   4. every table has RLS enabled; deny-all tables stay policy-free.
 *
 * A canary replays only the migrations BEFORE the lockdown and asserts the
 * hole is visible — proving the reader is not vacuously passing.
 *
 * Grant baseline: Supabase's default privileges give anon/authenticated ALL on
 * every new public table, so a table is "writable by grant" until a revoke says
 * otherwise. If you add a table that is meant to be API-only, add it to
 * GOVERNED (and `revoke insert, update, delete ... from anon, authenticated`)
 * or to DENY_ALL (RLS on, zero policies).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const LOCKDOWN_FILE = "20261016000048_rls_api_only_writes.sql";

/** Governed domain data: the API is the only writer, session users only read. */
const GOVERNED = [
  "projects", "milestones", "tasks",
  "resource_members", "allocations", "time_entries", "project_budget", "expenses",
  "risks", "issues", "clashes",
  "deletion_requests", "rebaselines", "rebaseline_signoffs",
  "task_dependencies", "documents",
  "change_requests", "decisions",
  "programs", "saved_views", "sprints",
  "timesheet_submissions",
] as const;

/**
 * User-owned, unaudited state whose non-select policy legitimately stays.
 * profiles: own display name (writes go through /api/me; the policy predates
 * it). notifications: own read state (read_at).
 */
const USER_OWNED_WRITE_POLICIES: Record<string, Cmd[]> = {
  profiles: ["update"],
  notifications: ["update"],
};

/** RLS on, zero policies, or `revoke all` — service role only, by design. */
const DENY_ALL = [
  "user_mfa", "api_tokens", "assistant_credentials", "assistant_conversations",
  "assistant_messages", "assistant_demo_usage", "user_preferences", "invites",
  "nopm_rate_counters", "calendar_feeds",
  "integration_connectors", "external_identities", "identity_link_codes",
  "integration_deliveries", "action_tokens", "inbound_actions",
] as const;

type Cmd = "select" | "insert" | "update" | "delete" | "all";
type Priv = "select" | "insert" | "update" | "delete" | "truncate" | "references" | "trigger";
type Role = "anon" | "authenticated";
const ROLES: Role[] = ["anon", "authenticated"];
const ALL_PRIVS: Priv[] = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
const WRITE_PRIVS: Priv[] = ["insert", "update", "delete"];

interface State {
  tables: Set<string>;
  rls: Set<string>;
  policies: Map<string, Map<string, Cmd>>; // table -> policy name -> command
  grants: Map<string, Record<Role, Set<Priv>>>; // table -> role -> privileges
}

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const cleanIdent = (s: string) => s.trim().replace(/^public\./, "").replace(/"/g, "");

/** Replay migrations (filename order) into the final table/policy/grant state. */
function replay(files: string[]): State {
  const st: State = { tables: new Set(), rls: new Set(), policies: new Map(), grants: new Map() };

  const addTable = (t: string) => {
    st.tables.add(t);
    if (!st.policies.has(t)) st.policies.set(t, new Map());
    if (!st.grants.has(t)) {
      st.grants.set(t, { anon: new Set(ALL_PRIVS), authenticated: new Set(ALL_PRIVS) });
    }
  };
  const addPolicy = (t: string, name: string, cmd: Cmd | undefined) => {
    if (!st.policies.has(t)) st.policies.set(t, new Map());
    st.policies.get(t)!.set(name, cmd ?? "all"); // no FOR clause = ALL
  };

  for (const file of files) {
    let sql = readFileSync(join(migrationsDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();

    // DO blocks: `foreach t in array array['a','b'] loop execute format('... %1$I ...')`.
    sql = sql.replace(/\bdo \$\$([\s\S]*?)\$\$ ?;/g, (_m, body: string) => {
      const arr = body.match(/foreach \w+ in array array\[([^\]]*)\]/);
      const tables = arr ? [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
      for (const t of tables) {
        if (/alter table %(?:1\$)?i enable row level security/.test(body)) st.rls.add(t);
        for (const p of body.matchAll(
          /create policy "([^"]+)" on %(?:1\$)?i(?: as \w+)?(?: for (select|insert|update|delete|all))?/g,
        )) {
          addPolicy(t, p[1].replace(/%1\$s|%s/g, t), p[2] as Cmd | undefined);
        }
      }
      return " ";
    });
    // Remaining $$ bodies are function definitions — nothing table-level in them.
    sql = sql.replace(/\$\$[\s\S]*?\$\$/g, " ");

    for (const raw of sql.split(";")) {
      const s = raw.trim();
      let m: RegExpMatchArray | null;

      if ((m = s.match(/^create table (?:if not exists )?([\w."]+)/))) {
        addTable(cleanIdent(m[1]));
      } else if ((m = s.match(/^drop table (?:if exists )?([\w."]+)/))) {
        const t = cleanIdent(m[1]);
        st.tables.delete(t); st.rls.delete(t); st.policies.delete(t); st.grants.delete(t);
      } else if ((m = s.match(/^alter table (?:only )?(?:if exists )?([\w."]+) (enable|disable) row level security/))) {
        const t = cleanIdent(m[1]);
        if (m[2] === "enable") st.rls.add(t); else st.rls.delete(t);
      } else if (
        (m = s.match(/^create policy ("[^"]+"|\w+) on ([\w."]+)(?: as \w+)?(?: for (select|insert|update|delete|all))?/))
      ) {
        addPolicy(cleanIdent(m[2]), cleanIdent(m[1]), m[3] as Cmd | undefined);
      } else if ((m = s.match(/^drop policy (?:if exists )?("[^"]+"|\w+) on ([\w."]+)/))) {
        st.policies.get(cleanIdent(m[2]))?.delete(cleanIdent(m[1]));
      } else if ((m = s.match(/^(grant|revoke) (.+?) on (.+?) (from|to) (.+)$/))) {
        const [, verb, privSpec, objSpec, , roleSpec] = m;
        // Function / sequence / schema grants are not table privileges.
        if (/^(function|sequence|schema|type|domain|language|database|foreign|all (functions|sequences|procedures|routines))\b/.test(objSpec)) continue;
        const objects = /^all tables in schema/.test(objSpec)
          ? [...st.tables]
          : objSpec.replace(/^table /, "").split(",").map(cleanIdent);
        const roles = new Set<Role>();
        for (const r of roleSpec.replace(/ (with grant option|cascade|restrict)\b.*$/, "").split(",").map(cleanIdent)) {
          if (r === "public") ROLES.forEach((x) => roles.add(x));
          else if (r === "anon" || r === "authenticated") roles.add(r);
        }
        const privs = new Set<Priv>();
        // Split on top-level commas only: `update (col_a, col_b)` is ONE privilege.
        for (const tok of privSpec.split(/,(?![^(]*\))/).map((x) => x.trim())) {
          const kw = tok.split(/[ (]/)[0];
          const columnLevel = tok.includes("(");
          if (columnLevel && verb === "revoke") continue; // never narrows a table-level grant (conservative)
          if (kw === "all") ALL_PRIVS.forEach((p) => privs.add(p));
          else if ((ALL_PRIVS as string[]).includes(kw)) privs.add(kw as Priv);
        }
        for (const t of objects) {
          const g = st.grants.get(t);
          if (!g) continue;
          for (const role of roles) {
            for (const p of privs) {
              if (verb === "grant") g[role].add(p); else g[role].delete(p);
            }
          }
        }
      }
    }
  }
  return st;
}

const nonSelect = (st: State, t: string) =>
  [...(st.policies.get(t) ?? new Map<string, Cmd>())].filter(([, cmd]) => cmd !== "select");

describe("RLS write lockdown — final state after every migration", () => {
  const st = replay(migrationFiles);

  it("the lockdown migration file exists", () => {
    expect(migrationFiles).toContain(LOCKDOWN_FILE);
  });

  it("every governed table still exists (a rename/removal must update this guard)", () => {
    for (const t of GOVERNED) expect(st.tables.has(t), `${t} no longer created by any migration`).toBe(true);
  });

  it("no table has an active insert/update/delete/all policy, except the user-owned allow-list", () => {
    for (const t of st.tables) {
      const writes = nonSelect(st, t);
      const allowed = USER_OWNED_WRITE_POLICIES[t];
      if (!allowed) {
        expect(
          writes,
          `${t} has write policy ${JSON.stringify(writes)} — session users could write it directly via PostgREST, ` +
            `skipping audit/four-eyes/lock checks. Route the write through an API route and drop the policy ` +
            `(add the table to GOVERNED), or — only for unaudited user-owned state — add it to USER_OWNED_WRITE_POLICIES.`,
        ).toEqual([]);
      } else {
        expect(writes.map(([, c]) => c).sort(), `${t} write policies drifted from the allow-list`).toEqual([...allowed].sort());
      }
    }
  });

  it("no governed table grants INSERT/UPDATE/DELETE to anon or authenticated", () => {
    for (const t of GOVERNED) {
      for (const role of ROLES) {
        const held = WRITE_PRIVS.filter((p) => st.grants.get(t)![role].has(p));
        expect(held, `${role} still holds ${held.join("/")} on ${t} — add it to a revoke in ${LOCKDOWN_FILE} (or a later migration)`).toEqual([]);
      }
    }
  });

  it("every governed table keeps a read policy (the console reads through the session client)", () => {
    for (const t of GOVERNED) {
      const cmds = [...(st.policies.get(t) ?? new Map<string, Cmd>()).values()];
      expect(cmds.includes("select"), `${t} lost its select policy`).toBe(true);
    }
  });

  it("every table has row level security enabled", () => {
    for (const t of st.tables) expect(st.rls.has(t), `${t} has no 'enable row level security'`).toBe(true);
  });

  it("deny-all tables stay policy-free (service role only)", () => {
    for (const t of DENY_ALL) {
      expect(st.tables.has(t), `${t} no longer created by any migration`).toBe(true);
      expect([...(st.policies.get(t) ?? new Map()).keys()], `${t} gained a policy`).toEqual([]);
    }
  });

  it("audit_log stays select-only", () => {
    expect([...st.policies.get("audit_log")!.values()]).toEqual(["select"]);
  });
});

describe("RLS write lockdown — the reader sees the original hole (canary)", () => {
  const before = replay(migrationFiles.filter((f) => f < LOCKDOWN_FILE));

  it("before 0048, every governed table with a write policy is detected (static, dynamic-loop and per-command forms)", () => {
    // timesheet_submissions never had a write policy (select-only since 0038).
    const hadPolicy = GOVERNED.filter((t) => t !== "timesheet_submissions");
    for (const t of hadPolicy) {
      expect(nonSelect(before, t).length, `canary: reader found no write policy on ${t} before 0048`).toBeGreaterThan(0);
    }
    // Spot-check each syntactic form explicitly.
    expect(nonSelect(before, "projects")).toEqual([["write projects", "all"]]); // static `for all`
    expect(nonSelect(before, "change_requests")).toEqual([["write_change_requests", "all"]]); // do-$$ loop
    expect(nonSelect(before, "saved_views").map(([, c]) => c).sort()).toEqual(["delete", "insert", "update"]); // per-command
  });

  it("before 0048, the default grants let anon/authenticated write the governed tables", () => {
    for (const t of GOVERNED) {
      for (const role of ROLES) {
        expect(before.grants.get(t)![role].has("update"), `canary: ${role} should hold update on ${t} before 0048`).toBe(true);
      }
    }
  });

  it("the user-owned allow-list policies exist before and after (0048 must not touch them)", () => {
    const after = replay(migrationFiles);
    for (const [t, cmds] of Object.entries(USER_OWNED_WRITE_POLICIES)) {
      expect(nonSelect(before, t).map(([, c]) => c)).toEqual(cmds);
      expect(nonSelect(after, t).map(([, c]) => c)).toEqual(cmds);
    }
  });
});
