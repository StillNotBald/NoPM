/**
 * Migration 0109 (atomic security and integration writes, R-163 and R-164) - source-text guard.
 * The behaviour itself (rollback when the audit write fails, the invite escape, the link-code consume + insert,
 * the masked connector view) is proved against a real database by scripts/local-db/probe-atomic-security.mjs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "supabase", "migrations", "20261018000109_atomic_security.sql");
const raw = readFileSync(FILE, "utf8");
const sql = raw
  .replace(/--[^\n]*/g, " ")
  .replace(/\s+/g, " ")
  .toLowerCase();

const DEDICATED = [
  "nopm_mfa_enroll",
  "nopm_mfa_challenge",
  "nopm_mfa_verify",
  "nopm_mfa_disable",
  "nopm_connector_write",
  "nopm_github_connector_write",
  "nopm_revoke_other_invites",
  "nopm_link_identity",
] as const;
const HELPERS = ["nopm_mask_external_id", "nopm_lark_connector_audit_view"] as const;

/** The text of one function: from "create or replace function <name>(" to the closing "$$;". */
function body(name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("$$", start + 40) + 2);
  return sql.slice(start, end + 3);
}

describe("0109 atomic_security: shape", () => {
  it("states its rollback and defines only functions (no table, column, trigger or data change)", () => {
    expect(raw).toMatch(/--\s*ROLLBACK\./);
    expect(sql).not.toMatch(/\bcreate table\b|\balter table\b|\bdrop table\b|\bdrop column\b|\btruncate\b|\bdelete from\b|\bcreate trigger\b/);
  });

  it("is idempotent: every function is create or replace", () => {
    for (const fn of [...DEDICATED, ...HELPERS]) expect(sql).toContain(`create or replace function ${fn}(`);
    expect(sql.match(/create or replace function /g)?.length).toBe(DEDICATED.length + HELPERS.length);
    expect(sql).not.toMatch(/create function /);
  });
});

describe("0109 atomic_security: every dedicated function", () => {
  for (const fn of DEDICATED) {
    it(`${fn}: security definer, pinned search_path, audit written by the shared helper in the same call`, () => {
      const b = body(fn);
      expect(b).toContain("security definer");
      expect(b).toContain("set search_path = public");
      expect(b).toContain("perform nopm_audit_insert(");
      // never its own copy of the 17-column insert
      expect(b).not.toMatch(/insert into audit_log/);
    });

    it(`${fn}: revoked from public, anon and authenticated, granted to the service role only`, () => {
      expect(sql).toMatch(new RegExp(`revoke execute on function ${fn}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role;`));
      expect(sql).not.toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to (public|anon|authenticated)`));
    });
  }

  it("the helpers are service-role only too", () => {
    for (const fn of HELPERS) {
      expect(sql).toMatch(new RegExp(`revoke execute on function ${fn}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role;`));
    }
  });

  it("no audit call carries a secret, a hash or a backup code", () => {
    const calls = sql.match(/perform nopm_audit_insert\(.*?\);/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(15);
    for (const call of calls) {
      expect(call).not.toMatch(/secret_enc|relay_secret_hash|totp_secret|backup_codes|backup_hash|p_secret_enc|code_hash/);
    }
  });
});

describe("0109 atomic_security: workspace filtering", () => {
  it("the two-step functions check the user belongs to the workspace before touching user_mfa", () => {
    for (const fn of ["nopm_mfa_enroll", "nopm_mfa_challenge", "nopm_mfa_verify", "nopm_mfa_disable"]) {
      const b = body(fn);
      expect(b).toContain("from profiles where id = p_user_id and workspace_id = p_workspace_id");
      expect(b.indexOf("from profiles where id = p_user_id")).toBeLessThan(b.indexOf("user_mfa"));
    }
  });

  it("the connector, invite and identity functions filter every table by workspace_id = p_workspace_id", () => {
    for (const fn of ["nopm_connector_write", "nopm_github_connector_write", "nopm_revoke_other_invites", "nopm_link_identity"]) {
      const b = body(fn);
      const writes = b.match(/\b(update|from|insert into) (integration_connectors|invites|identity_link_codes|external_identities|profiles|workspaces)\b/g) ?? [];
      expect(writes.length, fn).toBeGreaterThan(0);
      expect(b, fn).toMatch(/workspace_id = p_workspace_id/);
    }
    // every update / select on a workspace table in these functions names the workspace
    for (const fn of ["nopm_connector_write", "nopm_github_connector_write", "nopm_revoke_other_invites", "nopm_link_identity"]) {
      for (const stmt of body(fn).split(";")) {
        if (/\b(update|delete from) (integration_connectors|invites|identity_link_codes|external_identities)\b/.test(stmt)) {
          expect(stmt, `${fn}: ${stmt.slice(0, 80)}`).toMatch(/workspace_id = p_workspace_id|c\.workspace_id = p_workspace_id|i\.workspace_id = p_workspace_id/);
        }
      }
    }
    expect(body("nopm_github_connector_write")).toContain("update workspaces set work_event_rules = p_rules_after where id = p_workspace_id");
  });
});

describe("0109 atomic_security: R-163 two-step", () => {
  it("never touches the attempt counter or burns a TOTP step (those stay outside the audit transaction)", () => {
    for (const fn of ["nopm_mfa_enroll", "nopm_mfa_challenge", "nopm_mfa_verify", "nopm_mfa_disable"]) {
      const b = body(fn);
      expect(b).not.toContain("nopm_rate_check");
      expect(b).not.toMatch(/last_totp_step = (?!null)/);
      expect(b).not.toMatch(/last_totp_step = excluded\.last_totp_step\b(?!.*null)/);
    }
  });

  it("records the OUTCOME the app decided (it does not verify codes) and sets the audit action itself", () => {
    expect(body("nopm_mfa_challenge")).toContain("'auth.mfa.challenge_failed'");
    expect(body("nopm_mfa_challenge")).toContain("'auth.mfa.challenge_passed'");
    expect(body("nopm_mfa_verify")).toContain("'auth.mfa.verify_failed'");
    expect(body("nopm_mfa_verify")).toContain("'mfa.enabled'");
    expect(body("nopm_mfa_disable")).toContain("'auth.mfa.disable_failed'");
    expect(body("nopm_mfa_disable")).toContain("'mfa.disabled'");
    expect(body("nopm_mfa_enroll")).not.toMatch(/otplib|authenticator|checkdelta/);
  });

  it("burns a backup code with a compare-and-set, and keeps the missing-column fallback", () => {
    const c = body("nopm_mfa_challenge");
    expect(c).toContain("array_remove(backup_codes, p_backup_hash)");
    expect(c).toContain("backup_codes @> array[p_backup_hash]");
    expect(c).toContain("get diagnostics v_burned = row_count");
    for (const fn of ["nopm_mfa_enroll", "nopm_mfa_disable"]) {
      expect(body(fn)).toContain("p_reset_step");
    }
  });

  it("never writes JSON null into the NOT NULL backup_codes column", () => {
    expect(sql).not.toMatch(/backup_codes\s*=\s*null/);
  });
});

describe("0109 atomic_security: fix pass (review wave 1)", () => {
  it("W1-05: the two pure helpers pin the search_path too", () => {
    for (const fn of HELPERS) expect(body(fn)).toContain("set search_path = public");
  });
  it("W1-06: an empty id masks to an empty string", () => {
    expect(body("nopm_mask_external_id")).toContain("when p_id = '' then ''");
  });
  it("W1-10: the connector before view comes from the locked row, the rules before from the workspace row in the transaction", () => {
    const c = body("nopm_connector_write");
    expect(c).not.toContain("p_before ");
    expect(c).toContain("nopm_lark_connector_audit_view(v_cur, p_before_secrets)");
    const g = body("nopm_github_connector_write");
    expect(g).not.toContain("p_rules_before");
    expect(g).toContain("select work_event_rules into v_rules_before from workspaces where id = p_workspace_id for update");
  });
});

describe("0109 atomic_security: R-164", () => {
  it("connector writes build the masked audit view in SQL (ids masked, secrets only as presence flags)", () => {
    const v = body("nopm_lark_connector_audit_view");
    expect(v).toContain("nopm_mask_external_id(r.config ->> 'appid')");
    expect(v).toContain("nopm_mask_external_id(r.config -> 'digest' ->> 'chatid')");
    expect(v).not.toMatch(/'(secret_enc|relay_secret_hash|tenant_key)'/); // none of them is ever a key of the audit view
    expect(v).toContain("'tenant_pinned'");
    expect(body("nopm_connector_write")).toContain("nopm_lark_connector_audit_view(v_row, p_secrets)");
  });

  it("GitHub update writes the connector and workspaces.work_event_rules, each with its own audit row", () => {
    const b = body("nopm_github_connector_write");
    expect(b).toContain("'work_event_rules.update'");
    expect((b.match(/perform nopm_audit_insert\(/g) ?? []).length).toBe(4); // create, revoke, update-connector, update-rules
  });

  it("the invite sweep keeps the ilike escape and both guards and writes one row per revoked invite", () => {
    const b = body("nopm_revoke_other_invites");
    expect(b).toContain("replace(replace(replace(p_email, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    expect(b).toContain("i.email ilike v_pattern");
    expect(b).toContain("i.accepted_at is null");
    expect(b).toContain("i.revoked = false");
    expect(b).toContain("another invite for this email was accepted");
    expect(b).toContain("for r in");
  });

  it("the identity link locks the connector and the code, then consumes, revokes, inserts, pins and audits", () => {
    const b = body("nopm_link_identity");
    expect((b.match(/for update/g) ?? []).length).toBeGreaterThanOrEqual(2);
    for (const step of [
      "update identity_link_codes set used_at = now()",
      "update external_identities set revoked_at = now()",
      "insert into external_identities",
      "update integration_connectors set tenant_key = p_external_tenant",
      "perform nopm_audit_insert(",
    ]) {
      expect(b, step).toContain(step);
    }
    expect(b).toContain("exception when unique_violation then");
    expect(b).toContain("'integration.identity.link.blocked'");
    // no swallowed failure anywhere: the refusal record is part of the transaction too
    expect(b).not.toMatch(/exception when others/);
    // the order inside the transaction: pin, burn, revoke previous, insert, then the audit row
    const at = (needle: string) => b.lastIndexOf(needle);
    expect(at("set tenant_key = p_external_tenant")).toBeLessThan(at("insert into external_identities"));
    expect(at("insert into external_identities")).toBeLessThan(b.lastIndexOf("perform nopm_audit_insert("));
  });

  it("returns the same result codes the adapter maps", () => {
    const b = body("nopm_link_identity");
    for (const status of ["paused", "forbidden", "invalid_code", "already_used", "expired", "conflict", "linked"]) {
      expect(b).toContain(`'${status}'`);
    }
    for (const reason of ["tenant_mismatch", "account_taken", "already_linked", "duplicate"]) expect(b).toContain(`'${reason}'`);
  });
});
