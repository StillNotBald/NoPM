// NoPM local-DB probes — fixtures.
//
// Everything is created through the SERVICE-ROLE client against the LOCAL stack
// (guard.mjs refuses anything else). Each run mints its own workspace
// (`probe-<tag>`) so runs never collide; nothing is cleaned up because
// audit_log is append-only and its FK to workspaces blocks workspace deletion
// by design — reset the whole local stack with `npx supabase db reset` instead.
//
// Cast (one workspace per run):
//   admin     role admin    — owns connectors in the Lark probe
//   managerA  role manager  — the "maker" in every four-eyes scenario
//   managerB  role manager  — the "checker"
//   tokens.a        PAT created_by A, exact scopes incl. task:delete:approve
//   tokens.b        PAT created_by B, exact scopes incl. task:delete:approve
//   tokens.bWild    PAT created_by B, scopes ["task:*","project:*","change:*"] only
//   tokens.bStar    PAT created_by B, scopes ["*"] only
//                   (wildcards must NOT grant the privileged approve scopes)
//   tokens.orphan   PAT with created_by NULL + task:delete:approve
//                   (no recorded owner => null principal => can never approve)
import "./guard.mjs";
import { stack } from "./guard.mjs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";
import { CONTRACT } from "./contracts.mjs";
import { errText } from "./report.mjs";

export function newTag() {
  return `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
}

/** Service-role supabase-js client + a direct Postgres connection (both local). */
export async function connect() {
  const db = createClient(stack.supabaseUrl, stack.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // The Supabase CLI's local Postgres speaks plain TCP (no TLS) — unlike the
  // hosted DB that scripts/apply-migrations.mjs connects to with ssl.
  const pgc = new pg.Client({ connectionString: stack.dbUrl });
  try {
    await pgc.connect();
  } catch (e) {
    console.error(`Cannot reach local Postgres at ${new URL(stack.dbUrl).host}: ${e.message}`);
    console.error("Is the local stack running? (`npx supabase start` from web/, Docker must be up.)");
    process.exit(3);
  }
  return {
    db,
    pgc,
    async close() {
      await pgc.end();
    },
  };
}

/** Await a supabase-js builder and throw a readable Error on `.error`. */
export async function must(builder, what) {
  const { data, error } = await builder;
  if (error) throw new Error(`${what}: ${errText(error)}`);
  return data;
}

// ── tokens ─────────────────────────────────────────────────────────────────
// Mirrors web/src/lib/auth/tokens.ts exactly: raw = prefix + 24 random bytes
// base64url (32 chars); stored hash = lowercase hex SHA-256 of the raw string.
const TOKEN_PREFIX = process.env.NOPM_TOKEN_PREFIX || "npm_";

export function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export async function mintToken(db, { workspaceId, name, createdBy, scopes }) {
  const raw = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const row = await must(
    db
      .from("api_tokens")
      .insert({
        workspace_id: workspaceId,
        name,
        token_hash: hashToken(raw),
        prefix: TOKEN_PREFIX,
        scopes,
        created_by: createdBy,
      })
      .select("id")
      .single(),
    `api_tokens(${name})`,
  );
  return { id: row.id, raw, name, scopes, createdBy };
}

// ── users ──────────────────────────────────────────────────────────────────
export async function makeUser(db, { workspaceId, tag, label, role }) {
  const email = `probe-${tag}-${label}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw new Error(`auth user ${label}: ${errText(created.error)}`);
  const id = created.data.user.id;
  await must(
    db.from("profiles").insert({
      id,
      workspace_id: workspaceId,
      email,
      display_name: `Probe ${label}`,
      role,
    }),
    `profile ${label}`,
  );
  // Work identity — timesheet_submissions.member_id points here.
  const member = await must(
    db
      .from("resource_members")
      .insert({ workspace_id: workspaceId, name: `Probe ${label}`, email, role_title: "Probe", profile_id: id })
      .select("id")
      .single(),
    `resource_member ${label}`,
  );
  return { id, email, password, role, label: `Probe ${label}`, memberId: member.id };
}

// Exact scope names only: the privileged approve/decide verbs are never reachable through a wildcard.
const APPROVE_SCOPES = [
  "project:read", "milestone:read", "milestone:write", "task:read", "task:write",
  "task:delete:request", "task:delete:approve", "change:read", "change:write", "change:decide", "audit:read",
];

export async function createFixtures({ db }) {
  const tag = newTag();
  const ws = await must(
    db.from("workspaces").insert({ name: `Probe ${tag}`, slug: `probe-${tag}` }).select("id").single(),
    "workspace",
  );
  const workspaceId = ws.id;

  const admin = await makeUser(db, { workspaceId, tag, label: "admin", role: "admin" });
  const a = await makeUser(db, { workspaceId, tag, label: "managerA", role: "manager" });
  const b = await makeUser(db, { workspaceId, tag, label: "managerB", role: "manager" });

  const project = await must(
    db
      .from("projects")
      .insert({ workspace_id: workspaceId, code: `PRB-${tag.slice(-4).toUpperCase()}`, name: `Probe project ${tag}`, owner_id: admin.id })
      .select("id, name")
      .single(),
    "project",
  );

  const milestone = await must(
    db
      .from("milestones")
      .insert({ workspace_id: workspaceId, project_id: project.id, name: `Probe milestone ${tag}`, target_date: "2026-12-01" })
      .select("id, name")
      .single(),
    "milestone",
  );

  const tokens = {
    a: await mintToken(db, { workspaceId, name: "probe A", createdBy: a.id, scopes: APPROVE_SCOPES }),
    b: await mintToken(db, { workspaceId, name: "probe B", createdBy: b.id, scopes: APPROVE_SCOPES }),
    bWild: await mintToken(db, { workspaceId, name: "probe B wildcard", createdBy: b.id, scopes: ["task:*", "project:*", "change:*"] }),
    bStar: await mintToken(db, { workspaceId, name: "probe B global wildcard", createdBy: b.id, scopes: ["*"] }),
    orphan: await mintToken(db, { workspaceId, name: "probe orphan", createdBy: null, scopes: APPROVE_SCOPES }),
  };

  // Ready-made acting identities used by the DB-layer probes.
  // `principalId` is the HUMAN behind the actor (the four-eyes comparand).
  const actors = {
    aUser: { type: "user", id: a.id, label: a.label, principalId: a.id },
    aToken: { type: "token", id: tokens.a.id, label: "probe A", principalId: a.id },
    bUser: { type: "user", id: b.id, label: b.label, principalId: b.id },
    bToken: { type: "token", id: tokens.b.id, label: "probe B", principalId: b.id },
    orphanToken: { type: "token", id: tokens.orphan.id, label: "probe orphan", principalId: null },
  };

  return { tag, workspaceId, project, milestone, admin, a, b, tokens, actors };
}

// ── tasks + deletion requests ──────────────────────────────────────────────
export async function newTask(db, fx, label = "task") {
  return must(
    db
      .from("tasks")
      .insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, name: `${label} ${randomBytes(3).toString("hex")}` })
      .select("*")
      .single(),
    "task",
  );
}

/**
 * Insert a pending task deletion request RAISED BY `by` (an entry of fx.actors),
 * with the requester PRINCIPAL recorded the way migration 0045 expects.
 * Returns { task, request }.
 */
export async function newTaskDeletionRequest(db, fx, by) {
  const task = await newTask(db, fx, "doomed");
  const request = await must(
    db
      .from("deletion_requests")
      .insert({
        workspace_id: fx.workspaceId,
        target_type: "task",
        target_id: task.id,
        reason: "probe: four-eyes",
        status: "pending",
        requested_by_type: by.type,
        requested_by_id: by.id,
        requested_by_label: by.label,
        before: task,
        [CONTRACT.columns.deletion_requests.requester]: by.principalId,
      })
      .select("*")
      .single(),
    "deletion_request",
  );
  return { task, request };
}

/** Call the commit RPC (service role) as `approver`, by NAMED parameters. */
export function commitTaskDeletion(db, fx, requestId, approver, extra = {}) {
  return db.rpc(CONTRACT.rpc.task, {
    p_request_id: requestId,
    p_workspace_id: fx.workspaceId,
    p_approver_type: approver.type,
    p_approver_id: approver.id,
    p_approver_label: approver.label,
    [CONTRACT.rpc.principalParam]: approver.principalId,
    p_channel: "api",
    p_correlation_id: `probe-${fx.tag}`,
    ...extra,
  });
}

// ── audit helpers (direct SQL; audit_log is readable by the postgres role) ──
export async function auditCount(pgc, workspaceId) {
  const r = await pgc.query("select count(*)::int as n from audit_log where workspace_id = $1", [workspaceId]);
  return r.rows[0].n;
}

export async function auditRowsFor(pgc, workspaceId, targetIds) {
  const r = await pgc.query(
    `select action, target_type, target_id, actor_type, actor_id, channel, request_id, "after"
       from audit_log
      where workspace_id = $1 and target_id = any($2::uuid[])
      order by created_at, action`,
    [workspaceId, targetIds],
  );
  return r.rows;
}

/** Run an INSERT through pg and classify the outcome (SQLSTATE + constraint name). */
export async function tryInsert(pgc, table, row) {
  const cols = Object.keys(row);
  const sql = `insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`;
  try {
    const r = await pgc.query(sql, cols.map((c) => row[c]));
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    return { ok: false, code: e.code, constraint: e.constraint, message: e.message };
  }
}
