/**
 * R-84 — RPC-written audit-row provenance, migration-text drift test.
 *
 * nopm_commit_task_deletion, nopm_commit_project_deletion and
 * nopm_accept_invite each write audit_log rows directly inside their own
 * atomic transaction, never through writeAudit — so R-82's channel/
 * request_id provenance (migration 20260906000042) had a gap in exactly
 * these three functions until migration 20260906000044_rpc_audit_
 * provenance.sql. There is no live Postgres in this suite to exercise the
 * functions themselves, so — same source-text-drift approach as
 * lock-db-backstop.test.ts — this reads the actual migration files off
 * disk, finds the LAST one that (re)defines each function (by scanning in
 * filename order, which is timestamp order), and asserts the provenance
 * contract on that latest body. Because it re-scans the directory rather
 * than hardcoding "0044 is latest", it also doubles as the forward guard: a
 * future migration that redefines one of these three functions without
 * carrying the channel/correlation-id parameters forward fails this suite
 * the same day, not silently.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(__dirname, "..", "..", "..", "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const PROVENANCE_MIGRATION_NUMBER = 20260906000044;

function migrationNumber(filename: string): number {
  const m = filename.match(/^(\d+)_/);
  return m ? Number(m[1]) : 0;
}

function readMigration(filename: string): string {
  return readFileSync(join(migrationsDir, filename), "utf8");
}

/** The last migration file (in filename/timestamp order) that (re)defines fnName. */
function latestDefining(fnName: string): { file: string; text: string } {
  const defRe = new RegExp(`create (or replace )?function ${fnName}\\(`, "i");
  let latest: { file: string; text: string } | null = null;
  for (const file of migrationFiles) {
    const text = readMigration(file);
    if (defRe.test(text)) {
      latest = { file, text };
    }
  }
  if (!latest) {
    throw new Error(`no migration in ${migrationsDir} defines ${fnName} — has it been renamed or removed?`);
  }
  return latest;
}

/** Every `insert into audit_log (...)` column list in the given SQL text. */
function auditInsertColumnLists(text: string): string[] {
  return [...text.matchAll(/insert into audit_log \(([^)]*)\)/g)].map((m) => m[1]);
}

/**
 * `oldSig` is the signature the LATEST definition must drop before redefining
 * (so no stale overload stays callable). The two deletion-commit RPCs were
 * recreated a second time in 0045 (principal-aware four-eyes), which dropped
 * the 7-argument 0044 signature; nopm_accept_invite is still on its 0044 form.
 *
 * `channels` is the p_channel allow-list the INVALID_CHANNEL guard must carry:
 * the deletion RPCs also accept 'lark' since 0045 (a chat-card approval is
 * server-derived provenance); invites can never come from a chat connector.
 */
type FnCase = { name: string; oldSig: string; channels: string; minMigration: number };

const BASE_CHANNELS = "'ui', 'api', 'cli', 'mcp', 'assistant'";
const CHAT_CHANNELS = `${BASE_CHANNELS}, 'lark'`;
const PRINCIPAL_MIGRATION_NUMBER = 20261016000045;

const FUNCTIONS: FnCase[] = [
  {
    name: "nopm_commit_task_deletion",
    oldSig: "uuid, uuid, text, uuid, text, text, text",
    channels: CHAT_CHANNELS,
    minMigration: PRINCIPAL_MIGRATION_NUMBER,
  },
  {
    name: "nopm_commit_project_deletion",
    oldSig: "uuid, uuid, text, uuid, text, text, text",
    channels: CHAT_CHANNELS,
    minMigration: PRINCIPAL_MIGRATION_NUMBER,
  },
  {
    name: "nopm_accept_invite",
    oldSig: "text, uuid, text, text",
    channels: BASE_CHANNELS,
    minMigration: PROVENANCE_MIGRATION_NUMBER,
  },
];

describe("R-84: RPC audit-row provenance (migration-text drift test)", () => {
  for (const { name, oldSig, channels, minMigration } of FUNCTIONS) {
    describe(name, () => {
      const { file, text } = latestDefining(name);

      it(`latest definition lives in migration ${minMigration} or later (found in ${file})`, () => {
        expect(migrationNumber(file)).toBeGreaterThanOrEqual(minMigration);
      });

      it("drops the pre-provenance signature before redefining (avoids a stale overload)", () => {
        const dropRe = new RegExp(
          `drop function if exists ${name}\\(\\s*${oldSig.replace(/, /g, ",\\s*")}\\s*\\)`,
          "i",
        );
        expect(text).toMatch(dropRe);
      });

      it("takes p_channel and a correlation-id parameter, both defaulting to null", () => {
        expect(text).toMatch(/p_channel\s+text\s+default\s+null/i);
        expect(text).toMatch(/p_correlation_id\s+text\s+default\s+null/i);
      });

      it("guards p_channel against an out-of-set value (INVALID_CHANNEL)", () => {
        const fnBody = text.slice(text.indexOf(`function ${name}(`));
        expect(fnBody).toContain("INVALID_CHANNEL");
        expect(fnBody).toContain(`p_channel not in (${channels})`);
      });

      it("every audit_log insert's column list includes both channel and request_id", () => {
        const columnLists = auditInsertColumnLists(text);
        expect(columnLists.length).toBeGreaterThanOrEqual(2);
        for (const columns of columnLists) {
          expect(columns, `column list missing channel: ${columns}`).toContain("channel");
          expect(columns, `column list missing request_id: ${columns}`).toContain("request_id");
        }
      });

      it("re-applies the revoke-from-public/anon/authenticated + grant-to-service_role posture", () => {
        expect(text).toMatch(
          new RegExp(`revoke execute on function ${name}\\([^)]*\\) from public, anon, authenticated`),
        );
        expect(text).toMatch(new RegExp(`grant\\s+execute on function ${name}\\([^)]*\\) to service_role`));
      });
    });
  }

  it("nopm_accept_invite keeps its security definer + search_path clauses", () => {
    const { text } = latestDefining("nopm_accept_invite");
    const fnBody = text.slice(text.indexOf("function nopm_accept_invite("));
    expect(fnBody).toMatch(/security definer/i);
    expect(fnBody).toMatch(/set search_path = public/i);
  });

  it("forward guard: no migration numbered after 0044 redefines these functions without both provenance params", () => {
    for (const { name } of FUNCTIONS) {
      const defRe = new RegExp(`create (or replace )?function ${name}\\(`, "i");
      for (const file of migrationFiles) {
        if (migrationNumber(file) <= PROVENANCE_MIGRATION_NUMBER) continue;
        const text = readMigration(file);
        if (!defRe.test(text)) continue;
        const fnBody = text.slice(text.indexOf(`function ${name}(`));
        expect(fnBody, `${file} redefines ${name} but drops p_channel`).toMatch(/p_channel\s+text/);
        expect(fnBody, `${file} redefines ${name} but drops p_correlation_id`).toMatch(
          /p_correlation_id\s+text/,
        );
      }
    }
  });
});
