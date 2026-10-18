// NoPM local-DB probe - security and integration writes are atomic with their audit row (R-163, R-164, migration 0109).
//
// Calls the 0109 functions directly on the LOCAL database with a throwaway workspace. For every function it proves
// two things: the happy path writes the change AND exactly one audit row (two for GitHub rules), and a FAILING audit
// write (an invalid action name) leaves NO change behind, so an orphan row cannot exist. Also checked: no secret or
// backup-code hash in any audit row, the workspace guard, the invite ilike escape, the link-code consume + insert.
//
//   cd web && node scripts/local-db/probe-atomic-security.mjs        (needs migrations 0107 and 0109 applied locally)
//
// Exit codes: 0 all PASS - 1 at least one FAIL - 2 guard refused - 3 stack down.
import "./guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { createReport, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, must } from "./fixtures.mjs";

const { db, pgc, close } = await connect();
const report = createReport("Atomic security and integration writes - local database");
const fx = await createFixtures({ db });
const ws = fx.workspaceId;
console.log(`[fixtures] workspace=${ws}`);

const audit = (action, targetType, user, extra = {}) => ({
  action,
  target_type: targetType,
  actor_type: "user",
  actor_id: user.id,
  actor_label: user.label,
  channel: "api",
  request_id: `probe-${randomBytes(3).toString("hex")}`,
  principal_id: user.id,
  ...extra,
});
// A failing audit write: the helper refuses an unknown actor type (the MFA functions set the action themselves).
const BAD = (user) => ({ ...audit("mfa.enabled", "user_mfa", user), actor_type: "robot" });
const BADRE = /INVALID_ACTION|INVALID_ACTOR|P0057|P0058/;
const q = async (sql, params = []) => (await pgc.query(sql, params)).rows;
const rpc = async (fn, args) => {
  const keys = Object.keys(args);
  const sql = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}${typeof args[k] === "object" && args[k] !== null && !Array.isArray(args[k]) ? "::jsonb" : ""}`).join(", ")}) as r`;
  const params = keys.map((k) => (typeof args[k] === "object" && args[k] !== null && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
  return (await pgc.query(sql, params)).rows[0].r;
};
const rpcFails = async (fn, args, pattern) => {
  try {
    await rpc(fn, args);
  } catch (e) {
    expect(pattern.test(e.message + " " + (e.code ?? "")), `expected ${pattern}, got ${e.message}`);
    return e;
  }
  throw new Error(`${fn} did not fail`);
};
const auditRows = (action, targetId) =>
  q("select * from audit_log where workspace_id = $1 and action = $2 and target_id = $3 order by chain_seq", [ws, action, targetId]);
const auditCount = async () => (await q("select count(*)::int as n from audit_log where workspace_id = $1", [ws]))[0].n;
const mfaRow = async (id) => (await q("select * from user_mfa where user_id = $1", [id]))[0];

const u = fx.a; // acting user (manager A)
const SECRET_ENC = `enc.${randomBytes(12).toString("hex")}.v1`;
const HASH1 = randomBytes(16).toString("hex");
const HASH2 = randomBytes(16).toString("hex");

// ── MFA ────────────────────────────────────────────────────────────────────
await report.check("MFA-1", "enroll writes user_mfa and one mfa.enroll_started row, no secret in the row", async () => {
  const before = await auditCount();
  await rpc("nopm_mfa_enroll", { p_workspace_id: ws, p_user_id: u.id, p_secret_enc: SECRET_ENC, p_reset_step: true, p_audit: audit("mfa.enroll_started", "user_mfa", u) });
  expectEqual((await auditCount()) - before, 1, "one audit row");
  const row = await mfaRow(u.id);
  expect(row.totp_secret === SECRET_ENC && row.enabled === false, "user_mfa row written, factor off");
  const a = (await auditRows("mfa.enroll_started", u.id))[0];
  expectEqual(a.after, { enabled: false }, "after shape");
  expect(!JSON.stringify(a).includes(SECRET_ENC), "secret not in the audit row");
});

await report.check("MFA-2", "a failing audit write rolls the enrolment back (the old secret stays)", async () => {
  const before = await mfaRow(u.id);
  const n = await auditCount();
  await rpcFails("nopm_mfa_enroll", { p_workspace_id: ws, p_user_id: u.id, p_secret_enc: `enc.other.${randomBytes(4).toString("hex")}`, p_reset_step: true, p_audit: BAD(u) }, BADRE);
  expectEqual((await mfaRow(u.id)).totp_secret, before.totp_secret, "secret unchanged");
  expectEqual(await auditCount(), n, "no audit row");
});

await report.check("MFA-3", "the user must belong to the workspace (NOT_FOUND otherwise)", async () => {
  const other = (await must(db.from("workspaces").insert({ name: `Other ${fx.tag}`, slug: `other-${fx.tag}` }).select("id").single(), "other ws")).id;
  await rpcFails("nopm_mfa_enroll", { p_workspace_id: other, p_user_id: u.id, p_secret_enc: "x.y.z", p_reset_step: true, p_audit: audit("mfa.enroll_started", "user_mfa", u) }, /NOT_FOUND|P0002/);
});

await report.check("MFA-4", "verify failure records verify_failed only; verify ok enables, stores hashes, audits mfa.enabled", async () => {
  await rpc("nopm_mfa_verify", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "replay", p_backup_hashes: null, p_audit: audit("mfa.enabled", "user_mfa", u) });
  const failed = await auditRows("auth.mfa.verify_failed", u.id);
  expectEqual(failed.length, 1, "one verify_failed row");
  expectEqual(failed[0].after, { reason: "replay" }, "reason recorded");
  expectEqual((await mfaRow(u.id)).enabled, false, "still off");
  await rpcFails("nopm_mfa_verify", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "ok", p_backup_hashes: [HASH1, HASH2], p_audit: BAD(u) }, BADRE);
  expectEqual((await mfaRow(u.id)).enabled, false, "a failing audit leaves the factor off");
  await rpc("nopm_mfa_verify", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "ok", p_backup_hashes: [HASH1, HASH2], p_audit: audit("mfa.enabled", "user_mfa", u) });
  const row = await mfaRow(u.id);
  expect(row.enabled === true && row.backup_codes.length === 2 && row.confirmed_at, "enabled with 2 hashes");
  const en = (await auditRows("mfa.enabled", u.id))[0];
  expectEqual(en.before, { enabled: false }, "before");
  expectEqual(en.after, { enabled: true }, "after");
  expect(!JSON.stringify(en).includes(HASH1) && !JSON.stringify(en).includes(SECRET_ENC), "no hash or secret in the audit row");
});

await report.check("MFA-5", "challenge: totp passes with one row; a backup code burns once (compare-and-set); a failing audit keeps the code", async () => {
  const p = await rpc("nopm_mfa_challenge", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "totp", p_backup_hash: null, p_audit: audit("auth.mfa.challenge_passed", "user_mfa", u) });
  expectEqual(p.result, "passed", "totp passed");
  await rpcFails("nopm_mfa_challenge", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "backup_code", p_backup_hash: HASH1, p_audit: BAD(u) }, BADRE);
  expect((await mfaRow(u.id)).backup_codes.includes(HASH1), "code still present after a failed audit");
  const first = await rpc("nopm_mfa_challenge", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "backup_code", p_backup_hash: HASH1, p_audit: audit("auth.mfa.challenge_passed", "user_mfa", u) });
  const second = await rpc("nopm_mfa_challenge", { p_workspace_id: ws, p_user_id: u.id, p_outcome: "backup_code", p_backup_hash: HASH1, p_audit: audit("auth.mfa.challenge_passed", "user_mfa", u) });
  expectEqual([first.result, second.result], ["passed", "failed"], "the second use of the same code fails");
  expectEqual((await mfaRow(u.id)).backup_codes, [HASH2], "only the other code is left");
  const rows = await auditRows("auth.mfa.challenge_passed", u.id);
  expectEqual(rows.length, 2, "two passed rows (totp, first backup use)");
  expectEqual(rows[1].after, { via: "backup_code" }, "via recorded");
  expectEqual((await auditRows("auth.mfa.challenge_failed", u.id)).length, 1, "the lost race is audited as a failed challenge");
});

await report.check("MFA-6", "disable: failed mode audits only; a failing audit keeps the factor on; ok clears it", async () => {
  await rpc("nopm_mfa_disable", { p_workspace_id: ws, p_user_id: u.id, p_mode: "failed", p_reset_step: true, p_audit: audit("mfa.disabled", "user_mfa", u) });
  expectEqual((await auditRows("auth.mfa.disable_failed", u.id)).length, 1, "disable_failed row");
  expectEqual((await mfaRow(u.id)).enabled, true, "still on");
  await rpcFails("nopm_mfa_disable", { p_workspace_id: ws, p_user_id: u.id, p_mode: "code", p_reset_step: true, p_audit: BAD(u) }, BADRE);
  const still = await mfaRow(u.id);
  expect(still.enabled === true && still.totp_secret === SECRET_ENC, "factor intact after a failed audit");
  await rpc("nopm_mfa_disable", { p_workspace_id: ws, p_user_id: u.id, p_mode: "code", p_reset_step: false, p_audit: audit("mfa.disabled", "user_mfa", u) });
  const cleared = await mfaRow(u.id);
  expect(cleared.enabled === false && cleared.totp_secret === "" && cleared.backup_codes.length === 0, "cleared (secret wiped, no codes)");
  const d = (await auditRows("mfa.disabled", u.id))[0];
  expectEqual(d.before, { enabled: true }, "before");
  expect(d.after.enabled === false && d.after.via === "code", "after");
});

// ── Lark connector ─────────────────────────────────────────────────────────
const cfg = { region: "lark", appId: "cli_a1b2c3d4e5f6g7", mode: "webhook", approvals: { enabled: true }, digest: { enabled: true, chatId: "oc_0123456789abcdef", weekday: 3 } };
const flags = { has_app_secret: true, has_verification_token: true, has_encrypt_key: false, secrets_readable: true };
const LARK_SECRET = `lark.enc.${randomBytes(10).toString("hex")}`;
const RELAY_HASH = randomBytes(16).toString("hex");
let larkId = null;

await report.check("CON-1", "connector create: one audit row with the MASKED view and presence flags only", async () => {
  const r = await rpc("nopm_connector_write", {
    p_workspace_id: ws, p_op: "create", p_patch: { name: "Probe Lark", config: cfg, secret_enc: LARK_SECRET, relay_secret_hash: RELAY_HASH },
    p_created_by: fx.admin.id, p_secrets: flags, p_audit: audit("integration.connector.create", "integration_connector", fx.admin),
  });
  larkId = r.id;
  const a = (await auditRows("integration.connector.create", larkId))[0];
  expect(a, "audit row exists");
  expectEqual(a.after.app_id, "cli_a1…f6g7", "app id masked");
  expectEqual(a.after.digest.chat_id, "oc_012…cdef", "chat id masked");
  expectEqual([a.after.has_app_secret, a.after.has_encrypt_key, a.after.has_relay_secret, a.after.tenant_pinned], [true, false, true, false], "flags");
  const text = JSON.stringify(a);
  expect(!text.includes(LARK_SECRET) && !text.includes(RELAY_HASH) && !text.includes("cli_a1b2c3d4e5f6g7") && !text.includes("oc_0123456789abcdef"), "no secret, hash or raw id in the audit row");
});

await report.check("CON-2", "a second live connector is refused (23505) and a failing audit leaves no connector", async () => {
  try {
    await rpc("nopm_connector_write", { p_workspace_id: ws, p_op: "create", p_patch: { name: "Second", config: cfg, secret_enc: "x", relay_secret_hash: null }, p_created_by: fx.admin.id, p_secrets: flags, p_audit: audit("integration.connector.create", "integration_connector", fx.admin) });
    throw new Error("no error");
  } catch (e) {
    expect(e.code === "23505", `23505 expected, got ${e.code} ${e.message}`);
  }
  const ws2 = (await must(db.from("workspaces").insert({ name: `W2 ${fx.tag}`, slug: `w2-${fx.tag}` }).select("id").single(), "ws2")).id;
  await rpcFails("nopm_connector_write", { p_workspace_id: ws2, p_op: "create", p_patch: { name: "Orphan?", config: cfg, secret_enc: "x" }, p_created_by: null, p_secrets: flags, p_audit: BAD(fx.admin) }, BADRE);
  expectEqual((await q("select count(*)::int as n from integration_connectors where workspace_id = $1", [ws2]))[0].n, 0, "no orphan connector row");
});

await report.check("CON-3", "connector update: patch applied, one update row with extras, a failing audit changes nothing, revoked refused", async () => {
  const before = (await q("select name, status from integration_connectors where id = $1", [larkId]))[0];
  await rpcFails("nopm_connector_write", { p_workspace_id: ws, p_op: "update", p_connector_id: larkId, p_patch: { name: "Renamed", status: "paused" }, p_secrets: flags, p_audit: BAD(fx.admin) }, BADRE);
  expectEqual((await q("select name, status from integration_connectors where id = $1", [larkId]))[0], before, "unchanged after a failed audit");
  await rpc("nopm_connector_write", {
    p_workspace_id: ws, p_op: "update", p_connector_id: larkId, p_patch: { name: "Renamed", status: "paused" }, p_secrets: flags,
    p_before_secrets: flags, p_extras: { secrets_changed: [], relay_secret_rotated: false, tenant_pin_cleared: false },
    p_audit: audit("integration.connector.update", "integration_connector", fx.admin),
  });
  const row = (await q("select name, status, secret_enc, relay_secret_hash from integration_connectors where id = $1", [larkId]))[0];
  expect(row.name === "Renamed" && row.status === "paused" && row.secret_enc === LARK_SECRET && row.relay_secret_hash === RELAY_HASH, "only the patched keys changed");
  const a = (await auditRows("integration.connector.update", larkId))[0];
  expectEqual([a.after.status, a.after.relay_secret_rotated], ["paused", false], "after carries the view and the extras");
  expectEqual([a.before.name, a.before.status, a.before.app_id], ["Probe Lark", "active", "cli_a1…f6g7"], "before is built from the locked row, masked");
  await q("update integration_connectors set status = 'revoked', revoked_at = now() where id = $1", [larkId]);
  await rpcFails("nopm_connector_write", { p_workspace_id: ws, p_op: "update", p_connector_id: larkId, p_patch: { name: "Nope" }, p_secrets: flags, p_audit: audit("integration.connector.update", "integration_connector", fx.admin) }, /CONNECTOR_REVOKED/);
});

// ── GitHub connector ───────────────────────────────────────────────────────
let ghId = null;
const GH_SECRET = `gh.enc.${randomBytes(10).toString("hex")}`;
await report.check("GH-1", "GitHub create: one audit row {kind,name,status} without the secret; a duplicate is 23505", async () => {
  const r = await rpc("nopm_github_connector_write", { p_workspace_id: ws, p_op: "create", p_name: "GitHub", p_secret_enc: GH_SECRET, p_created_by: fx.admin.id, p_audit: audit("integration.connector.create", "integration_connector", fx.admin) });
  ghId = r.connector.id;
  const a = (await auditRows("integration.connector.create", ghId))[0];
  expectEqual(a.after, { kind: "github", name: "GitHub", status: "active" }, "after");
  expect(!JSON.stringify(a).includes(GH_SECRET), "no secret in the audit row");
  try {
    await rpc("nopm_github_connector_write", { p_workspace_id: ws, p_op: "create", p_name: "GitHub 2", p_secret_enc: "x", p_created_by: null, p_audit: audit("integration.connector.create", "integration_connector", fx.admin) });
    throw new Error("no error");
  } catch (e) {
    expect(e.code === "23505", `23505 expected, got ${e.code}`);
  }
});

await report.check("GH-2", "GitHub update writes the connector AND workspaces.work_event_rules with two audit rows, or neither", async () => {
  const rulesBefore = (await q("select work_event_rules as r from workspaces where id = $1", [ws]))[0].r;
  const nextRules = { ...(rulesBefore ?? {}), pr_merged: "started" };
  const n = await auditCount();
  await rpcFails("nopm_github_connector_write", { p_workspace_id: ws, p_op: "update", p_connector_id: ghId, p_status: "paused", p_rules_after: nextRules, p_audit: BAD(fx.admin) }, BADRE);
  expectEqual((await q("select status from integration_connectors where id = $1", [ghId]))[0].status, "active", "connector unchanged");
  expectEqual((await q("select work_event_rules as r from workspaces where id = $1", [ws]))[0].r, rulesBefore, "rules unchanged");
  expectEqual(await auditCount(), n, "no audit row");
  const r = await rpc("nopm_github_connector_write", { p_workspace_id: ws, p_op: "update", p_connector_id: ghId, p_status: "paused", p_secret_rotated: false, p_rules_after: nextRules, p_audit: audit("integration.connector.update", "integration_connector", fx.admin) });
  expect(r.rules_written === true && r.connector.status === "paused", "both written");
  expectEqual((await auditRows("integration.connector.update", ghId))[0].after, { kind: "github", status: "paused", secret_rotated: false }, "connector row");
  const rr = (await auditRows("work_event_rules.update", ws))[0];
  expectEqual([rr.target_type, rr.after], ["workspace", nextRules], "rules row");
  expectEqual(rr.before, rulesBefore, "rules before is read in the transaction");
  const rotated = await rpc("nopm_github_connector_write", { p_workspace_id: ws, p_op: "update", p_connector_id: ghId, p_secret_enc: "gh.enc.rotated", p_secret_rotated: true, p_audit: audit("integration.connector.update", "integration_connector", fx.admin) });
  expect(rotated.rules_written === false, "rules untouched when not sent");
});

await report.check("GH-3", "GitHub revoke: one revoke row, a second revoke is CONNECTOR_REVOKED, a failing audit keeps it live", async () => {
  await rpcFails("nopm_github_connector_write", { p_workspace_id: ws, p_op: "revoke", p_connector_id: ghId, p_audit: BAD(fx.admin) }, BADRE);
  expectEqual((await q("select status from integration_connectors where id = $1", [ghId]))[0].status, "paused", "still live");
  await rpc("nopm_github_connector_write", { p_workspace_id: ws, p_op: "revoke", p_connector_id: ghId, p_audit: audit("integration.connector.revoke", "integration_connector", fx.admin) });
  expectEqual((await auditRows("integration.connector.revoke", ghId))[0].after, { kind: "github", status: "revoked" }, "after");
  await rpcFails("nopm_github_connector_write", { p_workspace_id: ws, p_op: "revoke", p_connector_id: ghId, p_audit: audit("integration.connector.revoke", "integration_connector", fx.admin) }, /CONNECTOR_REVOKED/);
});

// ── invite sweep ───────────────────────────────────────────────────────────
await report.check("INV-1", "bulk invite revoke: escape, guards, one row per invite, all-or-nothing", async () => {
  const mk = async (email, extra = {}) =>
    (await must(db.from("invites").insert({ workspace_id: ws, email, role: "member", token_hash: randomBytes(16).toString("hex"), prefix: "npi_", created_by: fx.admin.id, expires_at: new Date(Date.now() + 86400000).toISOString(), ...extra }).select("id").single(), "invite")).id;
  const keep = await mk("a_b@x.com");
  const o1 = await mk("A_B@x.com"); // case-insensitive match
  const o2 = await mk("a_b@x.com");
  const notMatch = await mk("axb@x.com"); // underscore is a literal, not a wildcard
  const done = await mk("a_b@x.com", { accepted_at: new Date().toISOString() });
  const already = await mk("a_b@x.com", { revoked: true });
  const base = { p_workspace_id: ws, p_email: "a_b@x.com", p_keep_invite_id: keep };
  await rpcFails("nopm_revoke_other_invites", { ...base, p_audit: { ...audit("invite.revoked", "invite", fx.admin), actor_type: "robot" } }, BADRE);
  expectEqual((await q("select count(*)::int as n from invites where workspace_id = $1 and revoked = true", [ws]))[0].n, 1, "nothing revoked after a failed audit");
  const ids = await rpc("nopm_revoke_other_invites", { ...base, p_audit: audit("invite.revoked", "invite", fx.admin) });
  expectEqual([...ids].sort(), [o1, o2].sort(), "exactly the two open duplicates");
  const st = Object.fromEntries((await q("select id, revoked from invites where workspace_id = $1", [ws])).map((r) => [r.id, r.revoked]));
  expectEqual([st[keep], st[notMatch], st[done], st[already]], [false, false, false, true], "keep, other e-mail and accepted invite untouched");
  for (const id of [o1, o2]) {
    const a = (await auditRows("invite.revoked", id))[0];
    expectEqual(a.after.reason, "another invite for this email was accepted", "audit reason");
  }
});

// ── identity link ──────────────────────────────────────────────────────────
await report.check("ID-1", "link: code burned + identity + pin + one audit row together; a failing audit undoes all of it", async () => {
  const conn = await must(db.from("integration_connectors").insert({ workspace_id: ws, kind: "lark", name: "Link Lark", status: "active", config: cfg, secret_enc: "x", created_by: fx.admin.id }).select("id").single(), "lark connector");
  const mkCode = async (profile) => {
    const hash = randomBytes(16).toString("hex");
    await must(db.from("identity_link_codes").insert({ workspace_id: ws, connector_id: conn.id, profile_id: profile.id, code_hash: hash, expires_at: new Date(Date.now() + 600000).toISOString() }), "code");
    return hash;
  };
  const code = await mkCode(fx.admin);
  const args = (hash, user, tenant, ext, a) => ({ p_workspace_id: ws, p_connector_id: conn.id, p_code_hash: hash, p_profile_id: user.id, p_external_tenant: tenant, p_external_user_id: ext, p_external_union_id: null, p_display_name: "Probe", p_audit: a });
  await rpcFails("nopm_link_identity", args(code, fx.admin, "tenant-A", "ou_admin_123456", { ...audit("integration.identity.link", "external_identity", fx.admin), actor_type: "robot" }), BADRE);
  const c0 = (await q("select used_at from identity_link_codes where code_hash = $1", [code]))[0];
  expect(c0.used_at === null, "code still unused after a failed audit");
  expectEqual((await q("select count(*)::int as n from external_identities where connector_id = $1", [conn.id]))[0].n, 0, "no identity");
  expectEqual((await q("select tenant_key from integration_connectors where id = $1", [conn.id]))[0].tenant_key, null, "no pin");
  const ok = await rpc("nopm_link_identity", args(code, fx.admin, "tenant-A", "ou_admin_123456", audit("integration.identity.link", "external_identity", fx.admin, { channel: "lark", via_connector_id: conn.id })));
  expectEqual([ok.status, ok.already_linked], ["linked", false], "linked");
  expect((await q("select used_at from identity_link_codes where code_hash = $1", [code]))[0].used_at, "code burned");
  expectEqual((await q("select tenant_key from integration_connectors where id = $1", [conn.id]))[0].tenant_key, "tenant-A", "admin's first link pins the tenant");
  const ident = (await q("select id from external_identities where connector_id = $1 and revoked_at is null", [conn.id]))[0];
  const a = (await auditRows("integration.identity.link", ident.id))[0];
  expectEqual([a.channel, a.after.tenant_pinned, a.after.replaced_previous_link, a.after.external_ref], ["lark", true, false, "lark:te…:ou_adm…3456"], "audit shape (ids masked)");

  // another code for the same profile: refused replacement, code spent, blocked row
  const code2 = await mkCode(fx.admin);
  const held = await rpc("nopm_link_identity", args(code2, fx.admin, "tenant-A", "ou_other_654321", audit("integration.identity.link", "external_identity", fx.admin)));
  expectEqual([held.status, held.reason], ["conflict", "already_linked"], "profile already holds a link");
  // the refusal and its record are one transaction: a failing audit leaves the code usable
  const code2b = await mkCode(fx.admin);
  await rpcFails("nopm_link_identity", args(code2b, fx.admin, "tenant-A", "ou_other_654321", { ...audit("integration.identity.link", "external_identity", fx.admin), actor_type: "robot" }), BADRE);
  expect((await q("select used_at from identity_link_codes where code_hash = $1", [code2b]))[0].used_at === null, "code stays usable when the refusal cannot be recorded");
  expect((await q("select used_at from identity_link_codes where code_hash = $1", [code2]))[0].used_at, "spent");
  expectEqual((await auditRows("integration.identity.link.blocked", ident.id)).length, 1, "blocked row");
  expectEqual((await q("select nopm_mask_external_id('') as m"))[0].m, "", "an empty id masks to an empty string");

  // wrong tenant for a pinned connector, other account on the same platform account
  const code3 = await mkCode(fx.a);
  const wrong = await rpc("nopm_link_identity", args(code3, fx.a, "tenant-B", "ou_a_111111", audit("integration.identity.link", "external_identity", fx.a)));
  expectEqual([wrong.status, wrong.reason], ["forbidden", "tenant_mismatch"], "foreign tenant refused");
  expect((await q("select used_at from identity_link_codes where code_hash = $1", [code3]))[0].used_at === null, "code left usable");
  const taken = await rpc("nopm_link_identity", args(code3, fx.a, "tenant-A", "ou_admin_123456", audit("integration.identity.link", "external_identity", fx.a)));
  expectEqual([taken.status, taken.reason], ["conflict", "account_taken"], "platform account already linked to someone else");
  const again = await rpc("nopm_link_identity", args(code3, fx.a, "tenant-A", "ou_a_111111", audit("integration.identity.link", "external_identity", fx.a)));
  expectEqual(again.status, "linked", "a corrected attempt with the same code works");
  const reuse = await rpc("nopm_link_identity", args(code3, fx.a, "tenant-A", "ou_a_111111", audit("integration.identity.link", "external_identity", fx.a)));
  expectEqual(reuse.status, "already_used", "single use");
});

report.finish();
await close();
process.exit(report.failed ? 1 : 0);
