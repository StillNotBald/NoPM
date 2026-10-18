/**
 * Change-request export + audit pack data (audit item M3).
 *
 * Pure read helpers over the admin client, shared by GET /api/export
 * (`entity=change_requests` and `entity=audit_pack`) and the audit-pack PDF.
 *
 * Wave-2 columns (change_requests.implemented_*, impact_scope, documents
 * evidence columns, decisions.change_request_id) land in separate migrations.
 * Every read here selects them explicitly and falls back to the base columns
 * when the database does not have them yet, so a missing column reads as
 * "not recorded" (blank) rather than failing the download.
 */
import { dayAfter, type ExportRange } from "@/app/api/export/_audit-range";
import { getChainHead, type ChainHead } from "@/lib/audit/chain-head";
import { peekAnchor } from "@/lib/audit/anchor/anchor";
import { getAnchorSink } from "@/lib/audit/anchor/get-sink";
import type { AnchorStatus } from "@/lib/audit/anchor/compare";

/** Ids per .in() lookup, so a 10,000-row export never builds an oversized URL. */
export const ID_CHUNK = 100;
export const MAX_ROWS = 10_000;

type QResult = {
  data: unknown[] | null;
  count?: number | null;
  error: { message: string; code?: string } | null;
};

/** Minimal structural query builder. Loose on purpose: the generated builder types blow TS2589 when composed. */
export type Q = PromiseLike<QResult> & {
  select(columns: string, opts?: { count?: "exact" }): Q;
  eq(column: string, value: unknown): Q;
  in(column: string, values: unknown[]): Q;
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
  like(column: string, pattern: string): Q;
  or(filter: string): Q;
  order(column: string, opts?: { ascending?: boolean }): Q;
  range(from: number, to: number): Q;
};
export type ExportDb = { from(table: string): Q };

type Row = Record<string, unknown>;

/** Postgres undefined_column (42703) or PostgREST's schema-cache miss (PGRST204); nothing else counts as "column absent". */
function isMissingColumn(e: { message: string; code?: string } | null): boolean {
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  return /column [\w."]+ does not exist|could not find the '[^']+' column/i.test(e.message);
}

export const SCHEMA_OLDER = "not available (schema older than 0093/0094)";

/** Runs `run(full)`; if the database lacks a wave-2 column, runs `run(base)` instead. */
async function tolerant(run: (cols: string) => Q, full: string, base: string): Promise<QResult> {
  const first = await run(full);
  if (isMissingColumn(first.error)) return run(base);
  return first;
}

function fail(message: string): never {
  throw new Error(`Export query failed: ${message}`);
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

function distinct(ids: unknown[]): string[] {
  return [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/** profile id -> display name for the given ids, one chunked query, workspace-scoped. */
export async function profileLabels(db: ExportDb, workspaceId: string, ids: unknown[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks(distinct(ids))) {
    const { data, error } = await db
      .from("profiles")
      .select("id, display_name, email")
      .eq("workspace_id", workspaceId)
      .in("id", chunk);
    if (error) fail(error.message);
    for (const p of (data ?? []) as { id: string; display_name: string | null; email: string | null }[]) {
      out.set(p.id, p.display_name || p.email || "");
    }
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * impact_scope (jsonb array of { area, direction, note }, see impactScopeSchema)
 * as one cell: "area:direction (note)" entries joined by "; ".
 */
export function joinScope(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const { area, direction, note } = item as { area?: unknown; direction?: unknown; note?: unknown };
      if (typeof area !== "string" || !area) return "";
      const head = typeof direction === "string" && direction ? `${area}:${direction}` : area;
      return typeof note === "string" && note.trim() ? `${head} (${note.trim()})` : head;
    })
    .filter(Boolean)
    .join("; ");
}

const isPass = (r: unknown) => ["pass", "passed"].includes(String(r ?? "").toLowerCase());
const isFail = (r: unknown) => ["fail", "failed"].includes(String(r ?? "").toLowerCase());

// ─── change_requests ─────────────────────────────────────────────────────────

export const CHANGE_REQUEST_COLUMNS = [
  "id", "ref", "project_id", "project_code", "title", "category", "status", "priority",
  "raised_at", "requested_by_label", "requested_principal_id", "decided_at",
  "decided_by_label", "decided_principal_id", "decision", "decision_note",
  "impact_schedule_days", "impact_cost", "impact_scope", "implemented_at",
  "implemented_by_label", "evidence_count", "evidence_pass", "evidence_fail",
  "evidence_latest_at", "linked_decisions",
  // Approval tiers (G1) and the emergency path (R-159): an emergency commits on raise and is flagged "yes".
  // retro_due_at, retro_decided_at and retro_outcome are history for emergencies raised before the retro was
  // retired. retro_overdue is DEPRECATED: always blank, kept one release so tooling keyed on headers still works.
  "tier", "is_emergency", "retro_due_at", "retro_decided_at", "retro_outcome", "retro_overdue",
] as const;

const CR_BASE =
  "id, project_id, reference_id, title, category, status, priority, raised_at, requested_by_label, requested_principal_id, decided_at, decided_by_label, decided_principal_id, decision_rationale, impact_schedule_days, impact_cost, created_at, updated_at";
const CR_FULL = `${CR_BASE}, implemented_at, implemented_by, implemented_by_type, implemented_principal_id, implemented_note, impact_scope, tier, is_emergency, retro_due_at, retro_decided_at, retro_outcome`;

const DECISION_VERB: Record<string, string> = { approved: "approve", rejected: "reject", deferred: "defer" };

/** approve / reject / defer. An implemented request was approved first, so it reads "approve". */
function decisionVerb(status: string, decidedAt: unknown): string {
  if (DECISION_VERB[status]) return DECISION_VERB[status];
  if (status === "raised" || status === "under_review") return "";
  return decidedAt ? "approve" : "";
}

export type ChangeRequestFilter = (q: Q, hasImplementedAt: boolean) => Q;

export type ChangeRequestResult = { rows: Row[]; total: number };
export type ChangeRequestBundle = ChangeRequestResult & {
  evidence: Row[];
  linkedDecisions: Row[];
  /** False when the evidence / decision-link columns do not exist yet (older schema). */
  evidenceAvailable: boolean;
  decisionLinksAvailable: boolean;
};

/**
 * Change requests (workspace-filtered) with decision, implementation and
 * evidence roll-ups. `narrow` applies the caller's date filter. Labels,
 * project codes, evidence and linked decisions are resolved in batched
 * queries (chunks of 100 ids), never one query per row.
 */
export async function fetchChangeRequestRows(
  db: ExportDb,
  workspaceId: string,
  narrow: ChangeRequestFilter,
): Promise<ChangeRequestBundle> {
  const { data, error, count } = await tolerant(
    (cols) =>
      narrow(db.from("change_requests").select(cols, { count: "exact" }).eq("workspace_id", workspaceId), cols === CR_FULL)
        .order("raised_at", { ascending: true })
        .range(0, MAX_ROWS - 1),
    CR_FULL,
    CR_BASE,
  );
  if (error) fail(error.message);
  const rows = (data ?? []) as Row[];
  const total = count ?? rows.length;
  if (rows.length === 0) return { rows: [], total, evidence: [], linkedDecisions: [], evidenceAvailable: true, decisionLinksAvailable: true };

  const crIds = rows.map((r) => r.id as string);
  const [labels, projectCodes, evidenceRes, decisionsRes] = await Promise.all([
    profileLabels(db, workspaceId, rows.flatMap((r) => [r.implemented_principal_id, r.implemented_by])),
    projectCodeMap(db, workspaceId, rows.map((r) => r.project_id)),
    fetchEvidenceRows(db, workspaceId, crIds),
    fetchLinkedDecisions(db, workspaceId, crIds),
  ]);

  const evidence = evidenceRes.rows;
  const decisions = decisionsRes.rows;
  const evByCr = new Map<string, Row[]>();
  for (const e of evidence) {
    const k = e.change_request_id as string;
    evByCr.set(k, [...(evByCr.get(k) ?? []), e]);
  }
  const decByCr = new Map<string, string[]>();
  for (const d of decisions) {
    const k = d.change_request_id as string;
    decByCr.set(k, [...(decByCr.get(k) ?? []), String(d.reference_id || d.id)]);
  }

  const out = rows.map((r) => {
    const status = String(r.status ?? "");
    const ev = evByCr.get(r.id as string) ?? [];
    const latest = ev.map((e) => e.tested_at ?? e.created_at).filter(Boolean).sort().pop() ?? "";
    const by = typeof r.implemented_by === "string" ? r.implemented_by : "";
    const implementedBy =
      labels.get(r.implemented_principal_id as string) ??
      labels.get(by) ??
      (by && !UUID_RE.test(by) ? by : "");
    return {
      ...r,
      ref: r.reference_id ?? "",
      project_code: projectCodes.get(r.project_id as string) ?? "",
      decision: decisionVerb(status, r.decided_at),
      decision_note: r.decision_rationale ?? "",
      impact_scope: joinScope(r.impact_scope),
      implemented_at: r.implemented_at ?? "",
      implemented_by_label: implementedBy,
      evidence_count: evidenceRes.available ? ev.length : "",
      evidence_pass: evidenceRes.available ? ev.filter((e) => isPass(e.evidence_result)).length : "",
      evidence_fail: evidenceRes.available ? ev.filter((e) => isFail(e.evidence_result)).length : "",
      evidence_latest_at: latest,
      linked_decisions: (decByCr.get(r.id as string) ?? []).join(" "),
      tier: r.tier ?? "normal",
      is_emergency: r.is_emergency === true || r.tier === "emergency" ? "yes" : "",
      retro_due_at: r.retro_due_at ?? "",
      retro_decided_at: r.retro_decided_at ?? "",
      retro_outcome: r.retro_outcome ?? "",
      retro_overdue: "",
    } as Row;
  });
  return {
    rows: out,
    total,
    evidence,
    linkedDecisions: decisions,
    evidenceAvailable: evidenceRes.available,
    decisionLinksAvailable: decisionsRes.available,
  };
}

async function projectCodeMap(db: ExportDb, workspaceId: string, ids: unknown[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks(distinct(ids))) {
    const { data, error } = await db.from("projects").select("id, code").eq("workspace_id", workspaceId).in("id", chunk);
    if (error) fail(error.message);
    for (const p of (data ?? []) as { id: string; code: string | null }[]) out.set(p.id, p.code ?? "");
  }
  return out;
}

const EVIDENCE_SELECT =
  "id, reference_id, project_id, title, doc_type, status, created_at, change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note";

/** Documents attached as evidence to the given change requests. Empty when the evidence columns do not exist yet. */
async function fetchEvidenceRows(db: ExportDb, workspaceId: string, crIds: string[]): Promise<{ rows: Row[]; available: boolean }> {
  const out: Row[] = [];
  for (const chunk of chunks(crIds)) {
    const { data, error } = await db
      .from("documents")
      .select(EVIDENCE_SELECT)
      .eq("workspace_id", workspaceId)
      .in("change_request_id", chunk)
      .order("created_at", { ascending: true });
    if (error) {
      if (isMissingColumn(error)) return { rows: [], available: false };
      fail(error.message);
    }
    out.push(...((data ?? []) as Row[]));
  }
  return { rows: out, available: true };
}

const DECISION_SELECT =
  "id, reference_id, project_id, title, decision, rationale, status, decided_by_label, decided_at, created_at, change_request_id";
const DECISION_SELECT_BASE =
  "id, reference_id, project_id, title, decision, rationale, status, decided_by_label, decided_at, created_at";

/** Decisions linked to the given change requests. Empty when decisions.change_request_id does not exist yet. */
async function fetchLinkedDecisions(db: ExportDb, workspaceId: string, crIds: string[]): Promise<{ rows: Row[]; available: boolean }> {
  const out: Row[] = [];
  for (const chunk of chunks(crIds)) {
    const { data, error } = await db
      .from("decisions")
      .select(DECISION_SELECT)
      .eq("workspace_id", workspaceId)
      .in("change_request_id", chunk);
    if (error) {
      if (isMissingColumn(error)) return { rows: [], available: false };
      fail(error.message);
    }
    out.push(...((data ?? []) as Row[]));
  }
  return { rows: out, available: true };
}

// ─── audit pack ──────────────────────────────────────────────────────────────

export type AuditPackData = {
  workspaceName: string;
  /** Newest audit row_hash when the pack was built (R-154); printed on the cover. Null on a schema without the chain. */
  chainHead?: ChainHead | null;
  /** External anchor state when the pack was built (R-169f); render with anchorLine(). Absent reads as not anchored. */
  anchor?: AnchorStatus | null;
  from?: string;
  to?: string;
  generatedAt: string;
  generatedBy: string;
  changeRequests: Row[];
  evidence: Row[];
  decisions: Row[];
  audit: Row[];
  /** True when a section hit the row cap (the true count is in `totals`). */
  truncated: boolean;
  /** Sections the database cannot supply yet (older schema). Shown as such, never as "none". */
  unavailable: { evidence: boolean; decisionLinks: boolean };
  totals: { change_requests: number; evidence: number; decisions: number; approvals_audit: number };
};

/**
 * A change request is selected when it was raised, decided OR implemented inside
 * the range. `implemented_at` is left out only when the database does not have
 * that column yet. Used by the audit pack and by entity=change_requests.
 */
export function changeRequestRangeFilter(range: ExportRange): ChangeRequestFilter {
  return (q, hasImplementedAt) => {
    if (range.from === undefined && range.to === undefined) return q;
    const cols = hasImplementedAt ? ["raised_at", "decided_at", "implemented_at"] : ["raised_at", "decided_at"];
    const parts = cols.map((col) => {
      const conds: string[] = [];
      if (range.from !== undefined) conds.push(`${col}.gte.${range.from}T00:00:00Z`);
      if (range.to !== undefined) conds.push(`${col}.lt.${dayAfter(range.to)}`);
      return conds.length > 1 ? `and(${conds.join(",")})` : conds[0];
    });
    return q.or(parts.join(","));
  };
}

export async function gatherAuditPack(
  db: ExportDb,
  workspaceId: string,
  range: ExportRange,
  generatedBy: string,
): Promise<AuditPackData> {
  const [wsRes, cr] = await Promise.all([
    db.from("workspaces").select("name").eq("id", workspaceId),
    fetchChangeRequestRows(db, workspaceId, changeRequestRangeFilter(range)),
  ]);
  const workspaceName = ((wsRes.data ?? [])[0] as { name?: string } | undefined)?.name ?? "Workspace";
  const refById = new Map(cr.rows.map((r) => [r.id as string, String(r.ref || r.id)]));
  const codeById = new Map(cr.rows.map((r) => [r.id as string, String(r.project_code ?? "")]));

  const evidenceRaw = cr.evidence;
  const linked = cr.linkedDecisions;
  const [inRange, audit] = await Promise.all([
    fetchDecisionsInRange(db, workspaceId, range),
    fetchChangeAudit(db, workspaceId, cr.rows.map((r) => r.id as string)),
  ]);

  const evidence = evidenceRaw.map((e) => ({
    ...e,
    change_request_ref: refById.get(e.change_request_id as string) ?? "",
    project_code: codeById.get(e.change_request_id as string) ?? "",
  }));

  const seen = new Set<string>();
  const decisions: Row[] = [];
  for (const d of [...linked, ...inRange.rows]) {
    const id = d.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    decisions.push({ ...d, change_request_ref: refById.get(d.change_request_id as string) ?? "" });
  }

  const labels = await profileLabels(db, workspaceId, audit.rows.map((r) => r.principal_id));
  for (const a of audit.rows) {
    a.principal_label = typeof a.principal_id === "string" ? (labels.get(a.principal_id) ?? "") : "";
    a.change_request_ref = refById.get(a.target_id as string) ?? "";
  }

  return {
    workspaceName,
    from: range.from,
    to: range.to,
    generatedAt: new Date().toISOString(),
    generatedBy,
    chainHead: await getChainHead(db, workspaceId),
    anchor: await peekAnchor(db as unknown as Parameters<typeof peekAnchor>[0], getAnchorSink(), workspaceId),
    changeRequests: cr.rows,
    evidence,
    decisions,
    audit: audit.rows,
    unavailable: { evidence: !cr.evidenceAvailable, decisionLinks: !cr.decisionLinksAvailable },
    truncated: cr.total > cr.rows.length || audit.total > audit.rows.length || inRange.total > inRange.rows.length,
    totals: {
      change_requests: cr.total,
      evidence: evidence.length,
      decisions: decisions.length,
      approvals_audit: audit.total,
    },
  };
}

async function fetchDecisionsInRange(db: ExportDb, workspaceId: string, range: ExportRange): Promise<ChangeRequestResult> {
  let q = db.from("decisions").select(DECISION_SELECT_BASE, { count: "exact" }).eq("workspace_id", workspaceId);
  if (range.from !== undefined) q = q.gte("created_at", `${range.from}T00:00:00Z`);
  if (range.to !== undefined) q = q.lt("created_at", dayAfter(range.to));
  const { data, error, count } = await q.order("created_at", { ascending: true }).range(0, MAX_ROWS - 1);
  if (error) fail(error.message);
  const rows = (data ?? []) as Row[];
  return { rows, total: count ?? rows.length };
}

/**
 * The `change_request.*` audit rows for the SELECTED requests: who acted, on whose
 * behalf, when. Not limited to the date range: a request implemented inside the
 * range was decided before it, and the decide row is the proof an auditor needs.
 */
async function fetchChangeAudit(db: ExportDb, workspaceId: string, crIds: string[]): Promise<ChangeRequestResult> {
  const rows: Row[] = [];
  for (const chunk of chunks(crIds)) {
    const { data, error } = await db
      .from("audit_log")
      .select("id, action, actor_type, actor_label, principal_id, target_type, target_id, created_at")
      .eq("workspace_id", workspaceId)
      .like("action", "change_request.%")
      .in("target_id", chunk)
      .order("created_at", { ascending: true })
      .range(0, MAX_ROWS - 1);
    if (error) fail(error.message);
    rows.push(...((data ?? []) as Row[]));
  }
  rows.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
  const capped = rows.slice(0, MAX_ROWS);
  return { rows: capped, total: rows.length };
}

// ─── single-file CSV ─────────────────────────────────────────────────────────

export const AUDIT_PACK_COLUMNS = [
  "section",
  ...CHANGE_REQUEST_COLUMNS,
  // evidence / decision / audit sections reuse id, ref, title, status, project_code,
  // decided_at, decided_by_label, decision, decision_note and add:
  "change_request_ref", "evidence_type", "evidence_result", "tested_by_label", "tested_at",
  "evidence_note", "created_at", "action", "actor_type", "actor_label", "principal_id",
  "principal_label", "target_type", "target_id",
] as const;

/** One CSV row (in AUDIT_PACK_COLUMNS order) per record, tagged with its section. */
export function auditPackCsvRows(pack: AuditPackData): unknown[][] {
  const line = (section: string, r: Row) => AUDIT_PACK_COLUMNS.map((c) => (c === "section" ? section : (r[c] ?? "")));
  const rows: unknown[][] = [];
  for (const r of pack.changeRequests) rows.push(line("change_requests", r));
  for (const r of pack.evidence) {
    rows.push(line("evidence", { ...r, ref: r.reference_id, id: r.id, title: r.title, status: r.status }));
  }
  for (const r of pack.decisions) {
    rows.push(
      line("decisions", {
        ...r,
        ref: r.reference_id,
        decision: r.decision,
        decision_note: r.rationale,
        decided_by_label: r.decided_by_label,
        decided_at: r.decided_at,
      }),
    );
  }
  for (const r of pack.audit) rows.push(line("approvals_audit", r));
  if (pack.unavailable.evidence) rows.push(line("evidence", { title: SCHEMA_OLDER, status: "not_available" }));
  if (pack.unavailable.decisionLinks) rows.push(line("decisions", { title: `linked decisions ${SCHEMA_OLDER}`, status: "not_available" }));
  return rows;
}
