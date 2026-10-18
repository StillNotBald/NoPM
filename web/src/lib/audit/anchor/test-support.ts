/**
 * Test doubles for the anchor code: an in-memory sink and an in-memory stand-in for the slice of the
 * admin client the anchor code uses (audit_log head reads, audit_anchor_receipts, workspaces, the
 * verify RPC). Test support only: nothing in the app imports it.
 */
import type { Db } from "./receipts";
import type { AnchorRecord, AnchorSink, LatestResult, PutResult } from "./sink";

export class FakeSink implements AnchorSink {
  kind = "fake";
  records = new Map<string, AnchorRecord[]>();
  failLatest: string | null = null;
  failPut: string | null = null;
  putCalls: AnchorRecord[] = [];
  latestCalls = 0;

  seed(r: AnchorRecord) {
    this.records.set(r.workspace_id, [...(this.records.get(r.workspace_id) ?? []), r]);
  }

  async put(record: AnchorRecord): Promise<PutResult> {
    this.putCalls.push(record);
    if (this.failPut) return { status: "failed", error: this.failPut };
    const list = this.records.get(record.workspace_id) ?? [];
    const same = list.find((r) => r.chain_seq === record.chain_seq);
    if (same) return same.head_hash === record.head_hash ? { status: "exists", record: same } : { status: "conflict", stored: same };
    this.seed(record);
    return { status: "stored", record };
  }

  async latest(ids: readonly string[]): Promise<LatestResult> {
    this.latestCalls += 1;
    if (this.failLatest) return { ok: false, error: this.failLatest };
    const out = new Map<string, AnchorRecord>();
    for (const id of ids) {
      const list = this.records.get(id);
      if (list?.length) out.set(id, [...list].sort((a, b) => b.chain_seq - a.chain_seq)[0]);
    }
    return { ok: true, records: out };
  }
}

type Row = Record<string, unknown>;

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: [string, unknown][] = [];
  private gtFilter: [string, string] | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max = Infinity;
  private upsertRow: Row | null = null;
  constructor(private db: FakeAnchorDb, private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  not() { return this; }
  gt(c: string, v: string) { this.gtFilter = [c, v]; return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  upsert(row: Row) { this.upsertRow = row; return this; }
  private rows(): Row[] {
    let rows: Row[] =
      this.table === "audit_log" ? this.db.audit
      : this.table === "workspaces" ? this.db.workspaces.map((id) => ({ id }))
      : this.table === "audit_anchor_receipts" ? [...this.db.receipts.values()]
      : [];
    for (const [c, v] of this.filters) rows = rows.filter((r) => r[c] === v);
    if (this.gtFilter) { const [c, v] = this.gtFilter; rows = rows.filter((r) => String(r[c]) > v); }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (Number(a[col]) - Number(b[col])) || String(a[col]).localeCompare(String(b[col]))) ;
      if (!asc) rows.reverse();
    }
    return rows.slice(0, this.max);
  }
  async maybeSingle() {
    if (this.table === "audit_anchor_receipts" && this.db.failReceiptReads) return { data: null, error: { message: "relation does not exist" } };
    return { data: this.rows()[0] ?? null, error: null };
  }
  then<T1, T2>(ok?: (v: { data: unknown; error: null | { message: string } }) => T1 | PromiseLike<T1>, bad?: (e: unknown) => T2 | PromiseLike<T2>) {
    if (this.upsertRow) {
      if (this.db.failReceiptWrites) return Promise.resolve({ data: null, error: { message: "write refused" } }).then(ok, bad);
      const id = String(this.upsertRow.workspace_id);
      this.db.receipts.set(id, { ...(this.db.receipts.get(id) ?? {}), ...this.upsertRow });
      this.db.receiptWrites += 1;
      return Promise.resolve({ data: null, error: null }).then(ok, bad);
    }
    return Promise.resolve({ data: this.rows(), error: null }).then(ok, bad);
  }
}

export class FakeAnchorDb {
  audit: Row[] = [];
  workspaces: string[] = [];
  receipts = new Map<string, Row>();
  receiptWrites = 0;
  failReceiptWrites = false;
  failReceiptReads = false;
  verify: { ok: boolean; first_bad_id?: string | null } = { ok: true };
  verifyCalls: Record<string, unknown>[] = [];
  /** Append `n` rows to a workspace's chain, hashes "h<seq>". */
  grow(ws: string, n: number) {
    const have = this.audit.filter((r) => r.workspace_id === ws).length;
    for (let i = 1; i <= n; i++) this.audit.push({ workspace_id: ws, chain_seq: have + i, row_hash: `h${have + i}` });
    if (!this.workspaces.includes(ws)) this.workspaces.push(ws);
  }
  from(table: string) { return new Query(this, table); }
  async rpc(name: string, args: Record<string, unknown>) {
    if (name === "nopm_audit_verify_chain") {
      this.verifyCalls.push(args);
      return { data: [{ ok: this.verify.ok, checked: 1, first_bad_id: this.verify.first_bad_id ?? null }], error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  }
  asDb(): Db { return this as unknown as Db; }
}
