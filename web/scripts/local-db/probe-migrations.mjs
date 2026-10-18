// NoPM local-DB probe — migrations applied, new tables locked down, replay
// primitives enforced by the database.
//
//   cd web && node scripts/local-db/probe-migrations.mjs
//
// What it proves on the LOCAL stack (guard.mjs refuses anything else):
//   M1  every file in supabase/migrations is recorded as applied (so the
//       whole chain, including 0045-0047, ran in order on a clean database)
//   M2  every table from 0046/0047 has RLS enabled, ZERO policies and no
//       anon/authenticated privileges — and a signed-in user cannot read a row
//       that definitely exists (live check, not just catalog)
//   M3  the uniqueness constraints the Lark flow leans on are real database
//       constraints: one live connector per workspace, one active link per
//       profile and per external account, one inbound action per
//       (connector, external_event_id) — i.e. replay safety is not just code
//   M4  token / code hashes are unique (no two cards share an action token)
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack down.
import "./guard.mjs";
import { stack } from "./guard.mjs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { CONTRACT } from "./contracts.mjs";
import { createReport, errText, expect, expectEqual } from "./report.mjs";
import { connect, createFixtures, must, tryInsert } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "..", "supabase", "migrations");

const { db, pgc, close } = await connect();
const report = createReport("migrations + service-role-only tables");

// ── M1: applied == on disk ────────────────────────────────────────────────
await report.check("M1", "every migration file is recorded as applied (supabase CLI or _nopm_migrations)", async () => {
  const versionOf = (name) => name.split("_")[0];
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  expect(files.length > 0, `no migration files found in ${migrationsDir}`);
  const versions = files.map(versionOf);
  expect(new Set(versions).size === versions.length, "duplicate migration version prefixes on disk");

  let applied;
  let source;
  try {
    const r = await pgc.query("select version from supabase_migrations.schema_migrations");
    applied = new Set(r.rows.map((x) => String(x.version)));
    source = "supabase_migrations.schema_migrations";
  } catch {
    const r = await pgc.query("select name from _nopm_migrations");
    applied = new Set(r.rows.map((x) => versionOf(x.name)));
    source = "_nopm_migrations";
  }
  const missing = versions.filter((v) => !applied.has(v));
  expect(missing.length === 0, `not applied: ${missing.join(", ")}`);
  for (const v of ["20261016000045", "20261016000046", "20261016000047"]) {
    expect(applied.has(v), `new migration ${v} is not applied`);
  }
  return `${files.length} files, all applied (${source})`;
});

// ── M2: service-role-only tables ──────────────────────────────────────────
await report.check("M2a", "0046/0047 tables: RLS on, zero policies, no anon/authenticated privileges, workspace_id present", async () => {
  for (const t of CONTRACT.serviceRoleOnlyTables) {
    const rls = await pgc.query(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`]);
    expect(rls.rows[0]?.relrowsecurity === true, `${t}: row level security is not enabled`);
    const pol = await pgc.query(`select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1`, [t]);
    expectEqual(pol.rows[0].n, 0, `${t}: must have ZERO policies (service-role only)`);
    for (const role of ["anon", "authenticated"]) {
      const priv = await pgc.query(
        `select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i,
                has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d`,
        [role, `public.${t}`],
      );
      const p = priv.rows[0];
      expect(!p.s && !p.i && !p.u && !p.d, `${t}: ${role} still holds table privileges ${JSON.stringify(p)}`);
    }
    const ws = await pgc.query(
      `select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'workspace_id'`,
      [t],
    );
    expectEqual(ws.rowCount, 1, `${t}: workspace_id column missing`);
  }
});

// A full row set, one per table, so M2b/M3/M4 test rows that really exist.
const fx = await createFixtures({ db });
const tag = fx.tag;
let rows = null;
await report.check("M2-seed", "insert one row into every 0046/0047 table (service role)", async () => {
  const connector = await must(
    db
      .from("integration_connectors")
      .insert({ workspace_id: fx.workspaceId, kind: "lark", name: `probe ${tag}`, status: "active", config: {}, secret_enc: "probe-not-a-real-secret", created_by: fx.admin.id })
      .select("id")
      .single(),
    "integration_connectors",
  );
  const identity = await must(
    db
      .from("external_identities")
      .insert({ workspace_id: fx.workspaceId, connector_id: connector.id, external_tenant: `t-${tag}`, external_user_id: `ou_${tag}`, profile_id: fx.a.id })
      .select("id")
      .single(),
    "external_identities",
  );
  const code = await must(
    db
      .from("identity_link_codes")
      .insert({ workspace_id: fx.workspaceId, connector_id: connector.id, profile_id: fx.b.id, code_hash: `probe-code-${tag}`, expires_at: new Date(Date.now() + 600_000).toISOString() })
      .select("id")
      .single(),
    "identity_link_codes",
  );
  const delivery = await must(
    db
      .from("integration_deliveries")
      .insert({ workspace_id: fx.workspaceId, connector_id: connector.id, kind: "approval_card", status: "superseded", external_target: `ou_${tag}`, recipient_profile_id: fx.a.id })
      .select("id")
      .single(),
    "integration_deliveries",
  );
  const token = await must(
    db
      .from("action_tokens")
      .insert({ workspace_id: fx.workspaceId, delivery_id: delivery.id, recipient_profile_id: fx.a.id, approval_kind: "task_deletion", approval_id: randomUUID(), token_hash: `probe-token-${tag}`, expires_at: new Date(Date.now() + 86_400_000).toISOString() })
      .select("id")
      .single(),
    "action_tokens",
  );
  const inbound = await must(
    db
      .from("inbound_actions")
      .insert({ workspace_id: fx.workspaceId, connector_id: connector.id, external_event_id: `evt-${tag}`, action: "approve" })
      .select("id")
      .single(),
    "inbound_actions",
  );
  const feed = await must(
    db.from("calendar_feeds").insert({ workspace_id: fx.workspaceId, name: `probe ${tag}`, token_hash: `probe-feed-${tag}`, created_by: fx.a.id }).select("id").single(),
    "calendar_feeds",
  );
  rows = { connector, identity, code, delivery, token, inbound, feed };
});

await report.check("M2b", "a signed-in user (RLS) and the anon key cannot read ANY of those rows", async () => {
  expect(rows, "seed rows were not created (see M2-seed)");
  expect(stack.anonKey, "SUPABASE_ANON_KEY (ANON_KEY) is required for this live check");
  const anon = createClient(stack.supabaseUrl, stack.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const authed = createClient(stack.supabaseUrl, stack.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signIn = await authed.auth.signInWithPassword({ email: fx.a.email, password: fx.a.password });
  expect(!signIn.error, `sign-in as manager A failed: ${errText(signIn.error)}`);
  for (const t of CONTRACT.serviceRoleOnlyTables) {
    for (const [who, client] of [["anon", anon], ["authenticated", authed]]) {
      const { data } = await client.from(t).select("*");
      // Revoked privileges => an error; RLS-without-policy => an empty array. Rows are the only failure.
      expect(!data || data.length === 0, `${who} could read ${data?.length} row(s) of ${t}`);
    }
  }
  // Writes too: an insert must not succeed for the signed-in user.
  const w = await authed.from("calendar_feeds").insert({ workspace_id: fx.workspaceId, name: "x", token_hash: `probe-w-${tag}`, created_by: fx.a.id });
  expect(w.error, "authenticated user was able to INSERT into calendar_feeds");
});

// ── M3: replay / single-link primitives are database constraints ──────────
await report.check("M3a", "one live connector per workspace (second live lark connector rejected; revoked frees the slot)", async () => {
  expect(rows, "seed rows were not created");
  const dup = await tryInsert(pgc, "integration_connectors", {
    workspace_id: fx.workspaceId, kind: "lark", name: "dup", status: "paused", config: "{}", secret_enc: "x",
  });
  expect(!dup.ok && dup.code === "23505", `second live connector should be a unique violation, got ${dup.ok ? "accepted" : dup.code}`);
  await pgc.query("update integration_connectors set status = 'revoked', revoked_at = now() where id = $1", [rows.connector.id]);
  const again = await tryInsert(pgc, "integration_connectors", {
    workspace_id: fx.workspaceId, kind: "lark", name: "replacement", status: "active", config: "{}", secret_enc: "x",
  });
  expect(again.ok, `a replacement connector after revoke should be accepted: ${again.message}`);
});

await report.check("M3b", "identity links: one active link per external account AND per profile", async () => {
  expect(rows, "seed rows were not created");
  // Same external account, different profile.
  const sameAccount = await tryInsert(pgc, "external_identities", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, external_tenant: `t-${tag}`, external_user_id: `ou_${tag}`, profile_id: fx.b.id,
  });
  expect(!sameAccount.ok && sameAccount.code === "23505", `external account linked twice: ${sameAccount.ok ? "accepted" : sameAccount.code}`);
  // Same profile, different external account.
  const sameProfile = await tryInsert(pgc, "external_identities", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, external_tenant: `t-${tag}`, external_user_id: `ou_other_${tag}`, profile_id: fx.a.id,
  });
  expect(!sameProfile.ok && sameProfile.code === "23505", `profile linked twice: ${sameProfile.ok ? "accepted" : sameProfile.code}`);
});

await report.check("M3c", "inbound_actions: duplicate (connector, external_event_id) rejected — the replay ledger", async () => {
  expect(rows, "seed rows were not created");
  const dup = await tryInsert(pgc, "inbound_actions", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, external_event_id: `evt-${tag}`, action: "reject",
  });
  expect(!dup.ok && dup.code === "23505", `duplicate event id should be a unique violation, got ${dup.ok ? "accepted" : dup.code}`);
  const other = await tryInsert(pgc, "inbound_actions", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, external_event_id: `evt-${tag}-2`, action: "approve",
  });
  expect(other.ok, `a different event id must be accepted: ${other.message}`);
});

await report.check("M3d", "inbound_actions.action only accepts approve|reject", async () => {
  expect(rows, "seed rows were not created");
  const bad = await tryInsert(pgc, "inbound_actions", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, external_event_id: `evt-${tag}-3`, action: "delete",
  });
  expect(!bad.ok && bad.code === "23514", `expected a CHECK violation, got ${bad.ok ? "accepted" : bad.code}`);
});

// ── M4: hashed credentials are unique ─────────────────────────────────────
await report.check("M4", "action token / link code / feed hashes are unique", async () => {
  expect(rows, "seed rows were not created");
  const t = await tryInsert(pgc, "action_tokens", {
    workspace_id: fx.workspaceId, delivery_id: rows.delivery.id, recipient_profile_id: fx.b.id, approval_kind: "task_deletion",
    approval_id: randomUUID(), token_hash: `probe-token-${tag}`, expires_at: new Date(Date.now() + 1000).toISOString(),
  });
  expect(!t.ok && t.code === "23505", `duplicate action token hash: ${t.ok ? "accepted" : t.code}`);
  const c = await tryInsert(pgc, "identity_link_codes", {
    workspace_id: fx.workspaceId, connector_id: rows.connector.id, profile_id: fx.a.id, code_hash: `probe-code-${tag}`,
    expires_at: new Date(Date.now() + 1000).toISOString(),
  });
  expect(!c.ok && c.code === "23505", `duplicate link code hash: ${c.ok ? "accepted" : c.code}`);
  const f = await tryInsert(pgc, "calendar_feeds", {
    workspace_id: fx.workspaceId, name: "dup", token_hash: `probe-feed-${tag}`, created_by: fx.a.id,
  });
  expect(!f.ok && f.code === "23505", `duplicate feed token hash: ${f.ok ? "accepted" : f.code}`);
});

const allPassed = report.finish();
await close();
process.exit(allPassed ? 0 : 1);
