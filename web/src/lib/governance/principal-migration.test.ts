/**
 * Principal-aware four-eyes — migration-text drift test (migration 0045).
 *
 * There is no live Postgres in this suite, so — same source-text approach as
 * lock-db-backstop.test.ts and audit/rpc-provenance.test.ts — this reads the
 * migration off disk and asserts the contract the TypeScript layer relies on:
 * the principal columns exist, the principal-distinct CHECKs enforce going
 * forward, both deletion-commit RPCs take (and fail closed on) the approver's
 * principal, the old overloads are dropped (a still-callable old signature
 * would skip the principal check = a bypass), and the rebaseline trigger
 * compares humans. The database-level behaviour itself is exercised by the
 * local-DB probes (scripts/local-db), which the orchestrator runs against a
 * disposable local Supabase.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

const FILE = "20261016000045_principal_four_eyes.sql";
const text = readFileSync(join(migrationsDir, FILE), "utf8");
const PRINCIPAL_MIGRATION_NUMBER = 20261016000045;

/** The `alter table <table> ... ;` statement. */
function alterStatement(table: string): string {
  const m = text.match(new RegExp(`alter table ${table}\\b[^;]*;`, "i"));
  if (!m) throw new Error(`no "alter table ${table}" statement in ${FILE}`);
  return m[0];
}

function functionSource(name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  if (start < 0) throw new Error(`${FILE} does not define ${name}`);
  const end = text.indexOf("\n$$;", start);
  return text.slice(start, end + 4);
}

describe("0045 principal columns", () => {
  const cases: [string, string[]][] = [
    ["deletion_requests", ["requested_principal_id", "approved_principal_id"]],
    ["change_requests", ["requested_principal_id", "decided_principal_id"]],
    ["timesheet_submissions", ["submitted_principal_id", "decided_principal_id"]],
    ["rebaselines", ["requested_principal_id"]],
    ["rebaseline_signoffs", ["approver_principal_id"]],
  ];
  for (const [table, columns] of cases) {
    for (const column of columns) {
      it(`${table}.${column} is added as a nullable uuid`, () => {
        expect(alterStatement(table)).toMatch(new RegExp(`add column ${column}\\s+uuid\\b(?!\\s+not null)`, "i"));
      });
    }
  }

  it("no principal column carries a foreign key (evidence must outlive a deleted profile)", () => {
    for (const [table, columns] of cases) {
      for (const column of columns) {
        expect(alterStatement(table)).not.toMatch(new RegExp(`${column}\\s+uuid\\s+references`, "i"));
      }
    }
  });
});

describe("0045 backfill is retroactive for every actor", () => {
  it("user-actor rows take the user id and token-actor rows take api_tokens.created_by", () => {
    expect(text).toMatch(/update deletion_requests set requested_principal_id = requested_by_id\s+where requested_by_type = 'user'/i);
    expect(text).toMatch(/update deletion_requests dr set requested_principal_id = t\.created_by\s+from api_tokens t/i);
    expect(text).toMatch(/update change_requests cr set decided_principal_id = t\.created_by\s+from api_tokens t/i);
    expect(text).toMatch(/update timesheet_submissions ts set submitted_principal_id = t\.created_by\s+from api_tokens t/i);
  });

  it("token-raised rebaselines (which stored no actor) are recovered from the immutable audit row", () => {
    expect(text).toMatch(/a\.action = 'rebaseline\.create'/);
    expect(text).toMatch(/a\.actor_type = 'token'/);
    expect(text).toMatch(/join api_tokens t on t\.id = a\.actor_id/i);
  });

  it("the updated_at triggers are paused for the backfill and re-enabled after (no phantom 'modified now')", () => {
    for (const trg of [
      ["change_requests", "trg_change_requests_updated"],
      ["timesheet_submissions", "trg_timesheet_submissions_updated"],
    ]) {
      const [table, name] = trg;
      const off = text.search(new RegExp(String.raw`alter table ${table}\s+disable trigger ${name};`, "i"));
      const on = text.search(new RegExp(String.raw`alter table ${table}\s+enable trigger ${name};`, "i"));
      expect(off, `${name} is never disabled`).toBeGreaterThan(-1);
      expect(on, `${name} is never re-enabled`).toBeGreaterThan(off);
      // every UPDATE of the table sits between the two statements
      const lastUpdate = text.lastIndexOf(`update ${table}`);
      expect(lastUpdate).toBeGreaterThan(off);
      expect(lastUpdate).toBeLessThan(on);
    }
  });

  it("sign-off rows backfill from approver_id", () => {
    expect(text).toMatch(/update rebaseline_signoffs set approver_principal_id = approver_id/i);
  });
});

describe("0045 principal-distinct CHECKs", () => {
  const checks: [string, string, string, string][] = [
    ["deletion_requests", "deletion_principal_distinct", "approved_principal_id", "requested_principal_id"],
    ["change_requests", "cr_principal_distinct", "decided_principal_id", "requested_principal_id"],
    ["timesheet_submissions", "ts_principal_distinct", "decided_principal_id", "submitted_principal_id"],
  ];
  for (const [table, name, decider, requester] of checks) {
    it(`${table}.${name}: decider <> requester when both are known, NOT VALID (enforces going forward, never fails on history)`, () => {
      const stmt = alterStatement(table);
      // find the second alter (the constraint one), not the add-column one
      const constraint = text.match(new RegExp(`alter table ${table}\\s+add constraint ${name} check \\([^;]*?\\) not valid;`, "is"));
      expect(constraint, `${table}: constraint ${name} (not valid)`).not.toBeNull();
      const body = (constraint as RegExpMatchArray)[0];
      expect(body).toContain(`${decider} is null`);
      expect(body).toContain(`${requester} is null`);
      expect(body).toContain(`${decider} <> ${requester}`);
      expect(stmt).toBeTruthy();
    });
  }
});

describe("0045 deletion-commit RPCs", () => {
  for (const name of ["nopm_commit_task_deletion", "nopm_commit_project_deletion"]) {
    describe(name, () => {
      const fn = functionSource(name);
      const header = fn.slice(0, fn.indexOf("returns jsonb"));

      it("takes p_approver_principal_id (uuid, NO default) before the defaulted provenance params", () => {
        expect(header).toMatch(/p_approver_principal_id\s+uuid,/);
        expect(header).not.toMatch(/p_approver_principal_id\s+uuid\s+default/i);
        expect(header.indexOf("p_approver_principal_id")).toBeLessThan(header.indexOf("p_channel"));
      });

      it("keeps the 0044 provenance params and appends the optional note + connector provenance LAST, all defaulting to null (positional callers stay valid)", () => {
        expect(header).toMatch(
          /p_channel\s+text default null,\s*p_correlation_id\s+text default null,\s*p_note\s+text default null,\s*p_via_connector_id\s+uuid default null,\s*p_external_event_id\s+text default null,\s*p_external_actor_ref\s+text default null\s*\)\s*$/i,
        );
      });

      it("writes the connector provenance on EVERY audit_log row it inserts (columns are added by 0046; only referenced inside the function body)", () => {
        const lists = [...fn.matchAll(/insert into audit_log \(([^)]*)\)/g)].map((m) => m[1]);
        expect(lists.length).toBe(2);
        for (const columns of lists) {
          expect(columns).toContain("via_connector_id");
          expect(columns).toContain("external_event_id");
          expect(columns).toContain("external_actor_ref");
        }
        const passes = fn.match(/p_via_connector_id, p_external_event_id, p_external_actor_ref\)/g) ?? [];
        expect(passes.length).toBe(2);
        // 0046 owns the columns: this file must not alter audit_log itself.
        expect(text).not.toMatch(/alter table audit_log/i);
      });

      it("a null principal raises NO_PRINCIPAL (P0006) — fail-closed", () => {
        expect(fn).toMatch(/if p_approver_principal_id is null then\s+raise exception 'NO_PRINCIPAL' using errcode = 'P0006'/i);
      });

      it("a matching requester principal raises SELF_APPROVAL (P0003), alongside the legacy actor-id check", () => {
        expect(fn).toMatch(/r\.requested_by_id = p_approver_id then\s+raise exception 'SELF_APPROVAL' using errcode = 'P0003'/i);
        expect(fn).toMatch(
          /r\.requested_principal_id is not null and r\.requested_principal_id = p_approver_principal_id then\s+raise exception 'SELF_APPROVAL' using errcode = 'P0003'/i,
        );
      });

      it("records the approver's human on the request and in the governance audit row, with the optional note", () => {
        expect(fn).toMatch(/approved_principal_id = p_approver_principal_id/);
        expect(fn).toMatch(/'approver_principal_id', p_approver_principal_id/);
        expect(fn).toMatch(/jsonb_build_object\('note', v_note\)/);
      });

      it("accepts the 'lark' channel (server-derived chat provenance)", () => {
        expect(fn).toContain("p_channel not in ('ui', 'api', 'cli', 'mcp', 'assistant', 'lark')");
      });

      it("drops BOTH previous overloads so no principal-less signature stays callable", () => {
        expect(text).toMatch(new RegExp(`drop function if exists ${name}\\(uuid, uuid, text, uuid, text, text, text\\);`, "i"));
        expect(text).toMatch(new RegExp(`drop function if exists ${name}\\(uuid, uuid, text, uuid, text\\);`, "i"));
      });

      it("is service_role only (revoke from public/anon/authenticated, grant to service_role) on the NEW signature", () => {
        const sig = "uuid, uuid, text, uuid, text, uuid, text, text, text, uuid, text, text";
        expect(text).toContain(`revoke execute on function ${name}(${sig}) from public, anon, authenticated;`);
        expect(text).toMatch(new RegExp(`grant\\s+execute on function ${name}\\(${sig}\\) to service_role;`));
      });

      it("guards fire in the order the TypeScript layer (and its fake) assume: channel, principal, not-found, already-decided, self-approval", () => {
        const order = [...fn.matchAll(/raise exception '([A-Z_]+)/g)].map((m) => m[1]);
        const expected = ["INVALID_CHANNEL", "NO_PRINCIPAL", "NOT_FOUND", "ALREADY_DECIDED", "SELF_APPROVAL", "SELF_APPROVAL"];
        if (name === "nopm_commit_project_deletion") expected.push("PROJECT_LOCKED");
        expect(order).toEqual(expected);
      });
    });
  }

  it("forward guard: no later migration redefines either RPC without the principal parameter", () => {
    for (const name of ["nopm_commit_task_deletion", "nopm_commit_project_deletion"]) {
      const defRe = new RegExp(`create (or replace )?function ${name}\\(`, "i");
      for (const file of files) {
        const number = Number(file.match(/^(\d+)_/)?.[1] ?? 0);
        if (number <= PRINCIPAL_MIGRATION_NUMBER) continue;
        const body = readFileSync(join(migrationsDir, file), "utf8");
        if (!defRe.test(body)) continue;
        expect(body, `${file} redefines ${name} and drops p_approver_principal_id`).toMatch(/p_approver_principal_id\s+uuid/);
        expect(body, `${file} redefines ${name} without a NO_PRINCIPAL guard`).toContain("NO_PRINCIPAL");
      }
    }
  });
});

describe("0045 rebaseline sign-off trigger", () => {
  const fn = functionSource("nopm_rebaseline_no_self_signoff");

  it("compares the HUMAN on each side (requested_principal_id vs approver_principal_id), keeping the legacy profile check", () => {
    expect(fn).toMatch(/select requested_by, requested_principal_id into req_user, req_principal/i);
    expect(fn).toMatch(/req_user is not null and new\.approver_id = req_user/);
    expect(fn).toMatch(/req_principal is not null\s+and coalesce\(new\.approver_principal_id, new\.approver_id\) = req_principal/);
    expect(fn).toMatch(/errcode = 'P0003'/);
  });

  it("the trigger is (re)created on rebaseline_signoffs for insert or update", () => {
    expect(text).toMatch(
      /create trigger trg_rebaseline_no_self_signoff\s+before insert or update on rebaseline_signoffs\s+for each row execute function nopm_rebaseline_no_self_signoff\(\)/i,
    );
  });

  it("one vote per human per rebaseline: a unique index on (rebaseline_id, approver_id), created only when no duplicates exist", () => {
    expect(text).toMatch(/create unique index if not exists uniq_rebaseline_signoff_approver\s+on rebaseline_signoffs \(rebaseline_id, approver_id\)/i);
    expect(text).toMatch(/having count\(\*\) > 1/i);
  });
});
