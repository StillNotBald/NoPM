// NoPM local-DB probes — the names the probes ASSUME other workers' migrations
// and routes use. Kept in ONE place on purpose: if a worker named something
// differently, `preflight()` (run first by every DB probe) prints exactly which
// assumption is wrong, and this file is the only thing to edit.
//
// Source of truth for the assumptions: sprint-log/2026-10-16_lark-integration/PLAN.md
// (W1 / W3a / W4 detail sections) cross-checked against the migrations as written.

export const CONTRACT = {
  /** Commit RPCs (migration 0045 recreates both with a principal parameter). */
  rpc: {
    task: "nopm_commit_task_deletion",
    project: "nopm_commit_project_deletion",
    principalParam: "p_approver_principal_id",
    /** Connector provenance the commit RPCs stamp on their audit rows (so a chat-originated deletion is non-repudiable). */
    provenanceParams: ["p_via_connector_id", "p_external_event_id", "p_external_actor_ref"],
  },

  /** Principal columns added by migration 0045 (W1). */
  columns: {
    deletion_requests: { requester: "requested_principal_id", decider: "approved_principal_id" },
    change_requests: { requester: "requested_principal_id", decider: "decided_principal_id" },
    timesheet_submissions: { requester: "submitted_principal_id", decider: "decided_principal_id" },
    rebaselines: { requester: "requested_principal_id" },
    rebaseline_signoffs: { decider: "approver_principal_id" },
  },

  /** Principal-distinct CHECK constraint names added by 0045 (table -> name). */
  checks: {
    deletion_requests: "deletion_principal_distinct",
    change_requests: "cr_principal_distinct",
    timesheet_submissions: "ts_principal_distinct",
  },

  /** SQLSTATEs the 0045 RPCs raise. */
  errcodes: { selfApproval: "P0003", noPrincipal: "P0006", alreadyDecided: "P0001", invalidChannel: "P0005" },

  /** Tables created by 0046 (W3a) / 0047 (W4): all must be RLS-on with ZERO policies (service-role only). */
  serviceRoleOnlyTables: [
    "integration_connectors",
    "external_identities",
    "identity_link_codes",
    "integration_deliveries",
    "inbound_actions",
    "action_tokens",
    "calendar_feeds",
  ],

  /** audit_log columns added by 0046 (W3a). */
  auditColumns: ["via_connector_id", "external_event_id", "external_actor_ref"],

  /** The channels audit_channel_check must accept after 0046. */
  auditChannels: ["ui", "api", "cli", "mcp", "assistant", "lark"],
};

/**
 * Verify the assumptions above against the live local catalog. Returns a list
 * of human-readable problems (empty = every assumption holds).
 */
export async function preflight(pgc) {
  const problems = [];

  const cols = await pgc.query(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  );
  const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const need = (table, column, why) => {
    if (!have.has(`${table}.${column}`)) problems.push(`missing column ${table}.${column} (${why})`);
  };

  for (const [table, c] of Object.entries(CONTRACT.columns)) {
    for (const [role, column] of Object.entries(c)) need(table, column, `${role} principal, migration 0045`);
  }
  for (const column of CONTRACT.auditColumns) need("audit_log", column, "migration 0046");

  const tables = await pgc.query(`select tablename from pg_tables where schemaname = 'public'`);
  const haveTables = new Set(tables.rows.map((r) => r.tablename));
  for (const t of CONTRACT.serviceRoleOnlyTables) {
    if (!haveTables.has(t)) problems.push(`missing table ${t} (migration 0046/0047)`);
  }

  const checks = await pgc.query(
    `select conrelid::regclass::text as tbl, conname from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace`,
  );
  const haveChecks = new Set(checks.rows.map((r) => `${r.tbl.replace(/^public\./, "")}.${r.conname}`));
  for (const [table, name] of Object.entries(CONTRACT.checks)) {
    if (!haveChecks.has(`${table}.${name}`)) problems.push(`missing CHECK ${table}.${name} (migration 0045)`);
  }

  for (const fn of [CONTRACT.rpc.task, CONTRACT.rpc.project]) {
    const r = await pgc.query(
      `select p.oid, p.proargnames from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    if (r.rowCount === 0) problems.push(`missing function ${fn}`);
    else if (!r.rows.some((x) => (x.proargnames ?? []).includes(CONTRACT.rpc.principalParam))) {
      problems.push(`${fn} has no parameter named ${CONTRACT.rpc.principalParam}`);
    } else {
      for (const param of CONTRACT.rpc.provenanceParams) {
        if (!r.rows.some((x) => (x.proargnames ?? []).includes(param))) problems.push(`${fn} has no provenance parameter ${param}`);
      }
    }
  }
  return problems;
}
