// NoPM local-DB probe — can a signed-in non-viewer bypass the API with DIRECT PostgREST writes?
//
//   cd web && node scripts/local-db/probe-rls-direct-write.mjs                # target state: every write BLOCKED
//   cd web && node scripts/local-db/probe-rls-direct-write.mjs --expect-open  # record today's baseline (the hole)
//
// Every governed mutation is meant to go through an API route that writes exactly
// one audit row (`writeAudit`). But the browser holds the user's JWT and the
// anon key, and several tables carry an RLS policy "write ... for all using
// (workspace_id = my workspace and role <> 'viewer')". Through PostgREST that is
// a second, unaudited write path: a MEMBER can mark a change request approved
// "by" someone else, flip a deletion request to committed, spoof a rebaseline
// sign-off, delete a task outright, ... with no audit row.
//
// This probe signs in as real fixture users (anon key + password auth, exactly
// what a browser does) and attempts those writes. An RLS-denied UPDATE/DELETE
// silently affects zero rows (no error), so the verdict for every attempt comes
// from the DATABASE STATE read back with the service role, never from the HTTP
// result alone.
//
// Verdict per write: WROTE (state changed) or BLOCKED (error, or no effect).
//   default        PASS = BLOCKED  (the state after migration 0048 drops the write policies)
//   --expect-open  PASS = the same outcome today's baseline has: the numbered W* writes WROTE,
//                  the C* controls BLOCKED. This records the before-state as evidence.
// Reads must keep working in both modes (R*), and no direct write may leave an
// audit row (AUD) — which is exactly why the open writes are a governance hole.
//
// Exit codes: 0 all PASS · 1 at least one FAIL · 2 guard refused · 3 stack down.
import "./guard.mjs";
import { stack, needAnonKey } from "./guard.mjs";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { createReport, errText, expect, expectEqual } from "./report.mjs";
import { auditCount, connect, createFixtures, makeUser, must, newTaskDeletionRequest } from "./fixtures.mjs";

const expectOpen = process.argv.includes("--expect-open");
needAnonKey();
const { db, pgc, close } = await connect();
const report = createReport(`direct PostgREST writes by a signed-in user — ${expectOpen ? "BASELINE (expect the holes OPEN)" : "TARGET (expect every write BLOCKED)"}`);
const fx = await createFixtures({ db });
const tag = fx.tag;
console.log(`[fixtures] workspace=${fx.workspaceId}  mode=${expectOpen ? "--expect-open" : "expect-blocked"}`);

// ── actors: real auth users, signed in with the ANON key like a browser ──
const mk = (label, role) => makeUser(db, { workspaceId: fx.workspaceId, tag, label, role });
const users = {
  member: await mk("member", "member"),
  viewer: await mk("viewer", "viewer"),
  escalator: await mk("escalator", "member"), // sacrificed by W8
  hopper: await mk("hopper", "member"), // sacrificed by W9
};
async function signedIn(user) {
  const client = createClient(stack.supabaseUrl, stack.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in as ${user.label}: ${errText(error)}`);
  return client;
}
const as = {};
for (const [name, u] of Object.entries(users)) as[name] = await signedIn(u);

// ── seed data (service role; seeding writes no audit rows) ────────────────
const other = {};
other.ws = await must(db.from("workspaces").insert({ name: `Other ${tag}`, slug: `other-${tag}` }).select("id").single(), "other workspace");
other.project = await must(db.from("projects").insert({ workspace_id: other.ws.id, code: "OTH", name: `OtherProject ${tag}` }).select("id").single(), "other project");
other.task = await must(db.from("tasks").insert({ workspace_id: other.ws.id, project_id: other.project.id, name: `OtherTask ${tag}` }).select("id").single(), "other task");

const seedTask = (name) => must(db.from("tasks").insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, name }).select("id, name").single(), `task ${name}`);
const crOwn = await must(
  db
    .from("change_requests")
    .insert({
      workspace_id: fx.workspaceId,
      project_id: fx.project.id,
      title: `member's own change ${tag}`,
      status: "raised",
      requested_by: users.member.id,
      requested_by_type: "user",
      requested_by_id: users.member.id,
      requested_by_label: users.member.label,
      requested_principal_id: users.member.id,
    })
    .select("id")
    .single(),
  "member's change request",
);
const risk = await must(db.from("risks").insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, title: `risk ${tag}` }).select("id").single(), "risk");
const delReq = await newTaskDeletionRequest(db, fx, fx.actors.aToken); // pending; raised by A's agent token (principal A)
const rebaseline = await must(
  db
    .from("rebaselines")
    .insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, version: 1, status: "pending_approval", reason: "probe", requested_by: fx.a.id, requested_principal_id: fx.a.id })
    .select("id")
    .single(),
  "rebaseline",
);
const taskToDelete = await seedTask(`direct-delete ${tag}`);
const auditRow = await must(
  db.from("audit_log").insert({ workspace_id: fx.workspaceId, actor_type: "user", actor_id: fx.a.id, actor_label: fx.a.label, action: "probe.seed", target_type: "probe", channel: "api" }).select("id").single(),
  "seed audit row",
);
const auditBaseline = await auditCount(pgc, fx.workspaceId);

// ── the attempts ─────────────────────────────────────────────────────────
// `baseline` is today's expected outcome for --expect-open: "open" (the hole) or "blocked" (already safe).
// run() performs the write and returns { error, evidence } where `wrote` is decided by reading the DB.
const rows = (r) => (Array.isArray(r.data) ? r.data.length : r.data ? 1 : 0);
const result = (r, wrote, detail) => ({ wrote, evidence: r.error ? `${r.error.code ?? ""} ${String(r.error.message).slice(0, 90)}`.trim() : `HTTP ok, ${rows(r)} row(s) returned; ${detail}` });

const attempts = [
  {
    id: "W1",
    baseline: "open",
    desc: "member UPDATEs own change_request -> approved, decided_* = another person (spoofed four-eyes)",
    run: async () => {
      const r = await as.member
        .from("change_requests")
        .update({
          status: "approved",
          decided_by: fx.b.id,
          decided_by_type: "user",
          decided_by_id: fx.b.id,
          decided_by_label: fx.b.label,
          decided_principal_id: fx.b.id,
          decided_at: new Date().toISOString(),
          decision_rationale: "spoofed by direct write",
        })
        .eq("id", crOwn.id)
        .select("id");
      const s = (await pgc.query("select status, decided_by_id from change_requests where id = $1", [crOwn.id])).rows[0];
      return result(r, s.status === "approved", `db: status=${s.status} decided_by=${s.decided_by_id === fx.b.id ? "B (spoofed)" : s.decided_by_id}`);
    },
  },
  {
    id: "W2",
    // Blocked TODAY only by accident: the project-lock trigger calls a function that `authenticated` cannot
    // EXECUTE (42501). The write POLICY still allows it, so this is one grant away from open (see POL).
    baseline: "blocked",
    desc: "member INSERTs a task (today blocked only by a missing EXECUTE grant on the lock trigger, not by policy)",
    run: async () => {
      const name = `direct-insert ${tag}`;
      const r = await as.member.from("tasks").insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, name }).select("id");
      const n = (await pgc.query("select count(*)::int as n from tasks where workspace_id = $1 and name = $2", [fx.workspaceId, name])).rows[0].n;
      return result(r, n === 1, `db: ${n} matching row(s)`);
    },
  },
  {
    id: "W3",
    baseline: "open",
    desc: "member UPDATEs a project (description) they do not own",
    run: async () => {
      const marker = `direct-update ${tag}`;
      const r = await as.member.from("projects").update({ description: marker }).eq("id", fx.project.id).select("id");
      const d = (await pgc.query("select description from projects where id = $1", [fx.project.id])).rows[0].description;
      return result(r, d === marker, `db: description=${d === marker ? "changed" : "unchanged"}`);
    },
  },
  {
    id: "W4",
    baseline: "open",
    desc: "member DELETEs a risk",
    run: async () => {
      const r = await as.member.from("risks").delete().eq("id", risk.id).select("id");
      const n = (await pgc.query("select count(*)::int as n from risks where id = $1", [risk.id])).rows[0].n;
      return result(r, n === 0, `db: risk ${n === 0 ? "gone" : "still there"}`);
    },
  },
  {
    id: "W5",
    baseline: "open",
    desc: "member UPDATEs a pending deletion_request -> committed, approved_by = another person",
    run: async () => {
      const r = await as.member
        .from("deletion_requests")
        .update({
          status: "committed",
          approved_by_type: "user",
          approved_by_id: fx.b.id,
          approved_by_label: fx.b.label,
          approved_principal_id: fx.b.id,
          decided_at: new Date().toISOString(),
          committed_at: new Date().toISOString(),
        })
        .eq("id", delReq.request.id)
        .select("id");
      const s = (await pgc.query("select status, approved_by_id from deletion_requests where id = $1", [delReq.request.id])).rows[0];
      return result(r, s.status === "committed", `db: status=${s.status} approved_by=${s.approved_by_id === fx.b.id ? "B (spoofed)" : s.approved_by_id}`);
    },
  },
  {
    id: "W6",
    baseline: "open",
    desc: "member INSERTs a rebaseline_signoff voting 'go' as another approver",
    run: async () => {
      const r = await as.member
        .from("rebaseline_signoffs")
        .insert({ workspace_id: fx.workspaceId, rebaseline_id: rebaseline.id, approver_id: fx.b.id, approver_principal_id: fx.b.id, vote: "go", voted_at: new Date().toISOString(), comment: "spoofed by direct write" })
        .select("id");
      const n = (await pgc.query("select count(*)::int as n from rebaseline_signoffs where rebaseline_id = $1", [rebaseline.id])).rows[0].n;
      return result(r, n >= 1, `db: ${n} sign-off row(s) on the rebaseline`);
    },
  },
  {
    id: "W7",
    baseline: "blocked", // same accidental block as W2 (lock trigger EXECUTE grant)
    desc: "member DELETEs a task outright (four-eyes exists to prevent; blocked today only by the lock-trigger grant)",
    run: async () => {
      const r = await as.member.from("tasks").delete().eq("id", taskToDelete.id).select("id");
      const n = (await pgc.query("select count(*)::int as n from tasks where id = $1", [taskToDelete.id])).rows[0].n;
      return result(r, n === 0, `db: task ${n === 0 ? "gone" : "still there"}`);
    },
  },
  {
    id: "W8",
    baseline: "open",
    desc: "(extra) member UPDATEs their OWN profile.role -> 'admin' (privilege escalation)",
    run: async () => {
      const r = await as.escalator.from("profiles").update({ role: "admin" }).eq("id", users.escalator.id).select("id, role");
      const role = (await pgc.query("select role from profiles where id = $1", [users.escalator.id])).rows[0].role;
      return result(r, role === "admin", `db: role=${role}`);
    },
  },
  {
    id: "W9",
    // Blocked today, but only incidentally: PostgREST's mutation always has a RETURNING clause, which makes
    // Postgres re-check the NEW row against the SELECT policy (workspace_id = my workspace) — the hop fails.
    // The UPDATE policy itself (with check id = auth.uid()) would allow it, so this still needs the policy dropped.
    baseline: "blocked",
    desc: "(extra) member UPDATEs their OWN profile.workspace_id -> another tenant (blocked today only by RETURNING re-checking SELECT)",
    run: async () => {
      const r = await as.hopper.from("profiles").update({ workspace_id: other.ws.id }).eq("id", users.hopper.id);
      const ws = (await pgc.query("select workspace_id from profiles where id = $1", [users.hopper.id])).rows[0].workspace_id;
      return result(r, ws === other.ws.id, `db: workspace_id=${ws === other.ws.id ? "OTHER tenant" : "unchanged"}`);
    },
  },
  {
    id: "W10",
    baseline: "open",
    desc: "(extra) member UPDATEs a task's status directly (a Kanban move with no audit row)",
    run: async () => {
      const t = await seedTask(`direct-move ${tag}`);
      const r = await as.member.from("tasks").update({ status: "Done", status_type: "completed", completion_pct: 100 }).eq("id", t.id).select("id");
      const s = (await pgc.query("select status_type from tasks where id = $1", [t.id])).rows[0].status_type;
      return result(r, s === "completed", `db: status_type=${s}`);
    },
  },
  // ── controls: already blocked today; they prove a BLOCKED verdict is detectable ──
  {
    id: "C1",
    baseline: "blocked",
    desc: "control: a VIEWER INSERTs a task (policy excludes viewers)",
    run: async () => {
      const name = `viewer-insert ${tag}`;
      const r = await as.viewer.from("tasks").insert({ workspace_id: fx.workspaceId, project_id: fx.project.id, name }).select("id");
      const n = (await pgc.query("select count(*)::int as n from tasks where workspace_id = $1 and name = $2", [fx.workspaceId, name])).rows[0].n;
      return result(r, n === 1, `db: ${n} matching row(s)`);
    },
  },
  {
    id: "C2",
    baseline: "blocked",
    desc: "control: member INSERTs a timesheet_submission (read-only table by design)",
    run: async () => {
      const r = await as.member
        .from("timesheet_submissions")
        .insert({ workspace_id: fx.workspaceId, member_id: users.member.memberId, period_start: "2026-03-02", period_end: "2026-03-08", status: "approved", submitted_by: users.member.id, submitted_by_type: "user", submitted_by_label: users.member.label, decided_by: fx.b.id, decided_by_type: "user" })
        .select("id");
      const n = (await pgc.query("select count(*)::int as n from timesheet_submissions where member_id = $1", [users.member.memberId])).rows[0].n;
      return result(r, n >= 1, `db: ${n} row(s)`);
    },
  },
  {
    id: "C3",
    baseline: "blocked",
    desc: "control: member INSERTs an audit_log row (no insert policy)",
    run: async () => {
      const action = `direct.${tag}`;
      const r = await as.member.from("audit_log").insert({ workspace_id: fx.workspaceId, actor_type: "user", actor_id: users.member.id, actor_label: users.member.label, action, target_type: "probe" }).select("id");
      const n = (await pgc.query("select count(*)::int as n from audit_log where workspace_id = $1 and action = $2", [fx.workspaceId, action])).rows[0].n;
      return result(r, n >= 1, `db: ${n} row(s)`);
    },
  },
  {
    id: "C4",
    baseline: "blocked",
    desc: "control: member UPDATEs an audit_log row",
    run: async () => {
      const r = await as.member.from("audit_log").update({ action: "tampered" }).eq("id", auditRow.id).select("id");
      const a = (await pgc.query("select action from audit_log where id = $1", [auditRow.id])).rows[0].action;
      return result(r, a === "tampered", `db: action=${a}`);
    },
  },
  {
    id: "C5",
    baseline: "blocked",
    desc: "control: member INSERTs an api_tokens row with scope '*'",
    run: async () => {
      const name = `direct-token ${tag}`;
      const r = await as.member.from("api_tokens").insert({ workspace_id: fx.workspaceId, name, token_hash: randomBytes(32).toString("hex"), scopes: ["*"], created_by: users.member.id }).select("id");
      const n = (await pgc.query("select count(*)::int as n from api_tokens where workspace_id = $1 and name = $2", [fx.workspaceId, name])).rows[0].n;
      return result(r, n >= 1, `db: ${n} row(s)`);
    },
  },
  {
    id: "C6",
    baseline: "blocked",
    desc: "control: member INSERTs a task into ANOTHER workspace",
    run: async () => {
      const name = `cross-tenant ${tag}`;
      const r = await as.member.from("tasks").insert({ workspace_id: other.ws.id, project_id: other.project.id, name }).select("id");
      const n = (await pgc.query("select count(*)::int as n from tasks where workspace_id = $1 and name = $2", [other.ws.id, name])).rows[0].n;
      return result(r, n >= 1, `db: ${n} row(s)`);
    },
  },
  {
    id: "C7",
    baseline: "blocked",
    desc: "control: member INSERTs an integration_connectors row",
    run: async () => {
      const r = await as.member.from("integration_connectors").insert({ workspace_id: fx.workspaceId, kind: "lark", name: `direct ${tag}`, secret_enc: "x" }).select("id");
      const n = (await pgc.query("select count(*)::int as n from integration_connectors where workspace_id = $1", [fx.workspaceId])).rows[0].n;
      return result(r, n >= 1, `db: ${n} row(s)`);
    },
  },
  {
    id: "C8",
    baseline: "blocked",
    desc: "control: member UPDATEs the workspace row (rename)",
    run: async () => {
      const r = await as.member.from("workspaces").update({ name: `renamed ${tag}` }).eq("id", fx.workspaceId).select("id");
      const nm = (await pgc.query("select name from workspaces where id = $1", [fx.workspaceId])).rows[0].name;
      return result(r, nm === `renamed ${tag}`, `db: name=${nm}`);
    },
  },
];

for (const a of attempts) {
  await report.check(a.id, a.desc, async () => {
    const out = await a.run();
    const outcome = out.wrote ? "WROTE" : "BLOCKED";
    const want = expectOpen ? (a.baseline === "open" ? "WROTE" : "BLOCKED") : "BLOCKED";
    const note = `${outcome} (wanted ${want}) — ${out.evidence}`;
    expect(outcome === want, note);
    return note;
  });
}

// ── reads must keep working, and must stay tenant-scoped ──────────────────
await report.check("R1", "reads still work for the member: own-workspace rows visible in every table the UI reads", async () => {
  const wanted = { tasks: "id", projects: "id", milestones: "id", change_requests: "id", risks: "id", deletion_requests: "id", rebaselines: "id", audit_log: "id", profiles: "id" };
  const counts = {};
  for (const [table, col] of Object.entries(wanted)) {
    const r = await as.member.from(table).select(col).eq("workspace_id", fx.workspaceId);
    expect(!r.error, `${table}: read failed — ${errText(r.error)}`);
    counts[table] = r.data.length;
    // the W4 risk may be gone in the open baseline; every other table must have rows
    if (!(table === "risks" && r.data.length === 0 && expectOpen)) expect(r.data.length >= 1, `${table}: member sees 0 rows of their own workspace (counts so far ${JSON.stringify(counts)})`);
  }
  return JSON.stringify(counts);
});

await report.check("R2", "reads stay tenant-scoped: the other workspace's task is invisible to the member", async () => {
  const r = await as.member.from("tasks").select("id").eq("id", other.task.id);
  expect(!r.error, `read failed: ${errText(r.error)}`);
  expectEqual(r.data.length, 0, "a member must not read another tenant's rows");
});

await report.check("R3", "secrets stay unreadable: api_tokens, integration_connectors, calendar_feeds, user_mfa return nothing", async () => {
  for (const table of ["api_tokens", "integration_connectors", "calendar_feeds", "user_mfa"]) {
    const r = await as.member.from(table).select("*");
    expect(r.error || r.data.length === 0, `${table}: the member can read ${r.data?.length} row(s)`);
  }
});

// ── the catalog agrees with the behaviour ─────────────────────────────────
await report.check("POL", `write policies on the governed tables: ${expectOpen ? "present today (evidence of the hole)" : "none left"}`, async () => {
  const governed = ["tasks", "projects", "milestones", "change_requests", "risks", "issues", "deletion_requests", "rebaselines", "rebaseline_signoffs", "profiles"];
  const r = await pgc.query(
    "select tablename, cmd from pg_policies where schemaname = 'public' and tablename = any($1) and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE') order by 1, 2",
    [governed],
  );
  const list = r.rows.map((x) => `${x.tablename}:${x.cmd}`);
  if (expectOpen) expect(list.length > 0, "--expect-open but no write policies exist: the holes are already closed, run without the flag");
  else expect(list.length === 0, `write policies still present: ${list.join(", ")}`);
  return list.length ? list.join(", ") : "none";
});

// ── the point: none of these writes left an audit row ─────────────────────
await report.check("AUD", "direct writes wrote ZERO audit rows (no governed trail for the writes above)", async () => {
  const delta = (await auditCount(pgc, fx.workspaceId)) - auditBaseline;
  const wrote = report.rows.filter((r) => /^W\d/.test(r.id) && /^WROTE/.test(r.note)).length;
  expectEqual(delta, 0, `audit rows appeared (${delta}) — something other than the direct writes wrote to audit_log`);
  return `${wrote} state-changing write(s) succeeded, audit rows added: ${delta}`;
});

const allPassed = report.finish();
const open = report.rows.filter((r) => /^W\d/.test(r.id) && /^WROTE/.test(r.note ?? "")).map((r) => r.id);
console.log(`direct writes that SUCCEEDED: ${open.length ? open.join(", ") : "none"}`);
await close();
process.exit(allPassed ? 0 : 1);
