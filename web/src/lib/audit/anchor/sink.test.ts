import { describe, it, expect, beforeEach, vi } from "vitest";

// A scripted stand-in for the `pg` driver: records every query and answers from a queue.
const pgState = vi.hoisted(() => ({
  configs: [] as unknown[],
  queries: [] as { sql: string; values?: readonly unknown[] }[],
  replies: [] as (unknown | Error)[],
  connectError: null as Error | null,
  ended: 0,
}));
vi.mock("pg", () => {
  class Client {
    constructor(cfg: unknown) {
      pgState.configs.push(cfg);
    }
    async connect() {
      if (pgState.connectError) throw pgState.connectError;
    }
    async query(sql: string, values?: readonly unknown[]) {
      pgState.queries.push({ sql, values });
      const r = pgState.replies.shift();
      if (r instanceof Error) throw r;
      return r ?? { rows: [], rowCount: 0, command: "" };
    }
    async end() {
      pgState.ended += 1;
    }
  }
  return { default: { Client, Pool: class {} }, Client };
});

import { ANCHOR_TABLE_SQL } from "./bootstrap-sql";
import { getAnchorSink } from "./get-sink";
import { noopSink } from "./noop-sink";
import { anchorClientConfig, createPostgresSink } from "./postgres-sink";
import { safeAnchorError } from "./sink";

const URL_OK = "postgresql://nopm_anchor:s3cretpw@db.example.test:5432/anchors?sslmode=disable";
const REC = { workspace_id: "11111111-1111-4111-8111-111111111111", chain_seq: 10, head_hash: "h10", row_count: 10, anchored_at: "2026-10-18T20:09:00.000Z" };
const row = (over: Record<string, unknown> = {}) => ({ workspace_id: REC.workspace_id, chain_seq: "10", head_hash: "h10", row_count: "10", anchored_at: new Date(REC.anchored_at), ...over });

beforeEach(() => {
  pgState.configs.length = 0;
  pgState.queries.length = 0;
  pgState.replies.length = 0;
  pgState.connectError = null;
  pgState.ended = 0;
});

describe("getAnchorSink", () => {
  it("is the no-op when NOPM_ANCHOR_DB_URL is unset or blank", async () => {
    expect(getAnchorSink({})).toBe(noopSink);
    expect(getAnchorSink({ NOPM_ANCHOR_DB_URL: "   " })).toBe(noopSink);
    expect(noopSink.kind).toBe("none");
    expect(await noopSink.put(REC)).toEqual({ status: "disabled" });
    expect(await noopSink.latest([REC.workspace_id])).toEqual({ ok: true, records: new Map() });
    expect(pgState.configs).toHaveLength(0);
  });
  it("is the Postgres sink when it is set", () => {
    expect(getAnchorSink({ NOPM_ANCHOR_DB_URL: URL_OK }).kind).toBe("postgres");
  });
});

describe("anchorClientConfig: TLS and timeouts (PR-17)", () => {
  it("always uses TLS and strict timeouts, and drops any sslmode from the URL", () => {
    const c = anchorClientConfig(URL_OK, {});
    if (!("config" in c)) throw new Error("expected a config");
    expect(c.config.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.config.connectionString).not.toContain("sslmode");
    expect(c.config.connectionTimeoutMillis).toBe(5000);
    expect(c.config.statement_timeout).toBe(5000);
    expect(c.config.query_timeout).toBe(5000);
  });
  it("verifies the certificate on request", () => {
    const c = anchorClientConfig(URL_OK, { NOPM_ANCHOR_SSL_VERIFY: "1" });
    expect("config" in c && c.config.ssl).toEqual({ rejectUnauthorized: true });
  });
  it("turns TLS off only for a loopback host AND the explicit flag", () => {
    const local = "postgresql://u:p@127.0.0.1:54322/nopm_anchor";
    const on = anchorClientConfig(local, { NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK: "1" });
    expect("config" in on && on.config.ssl).toBe(false);
    expect("config" in anchorClientConfig(local, {}) && (anchorClientConfig(local, {}) as { config: { ssl: unknown } }).config.ssl).toEqual({ rejectUnauthorized: false });
    const remote = anchorClientConfig(URL_OK, { NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK: "1" });
    expect("config" in remote && remote.config.ssl).toEqual({ rejectUnauthorized: false });
  });
  it("rejects a URL that is not Postgres", () => {
    expect(anchorClientConfig("https://example.test/x", {})).toHaveProperty("error");
    expect(anchorClientConfig("not a url", {})).toHaveProperty("error");
  });
});

describe("postgres sink: put", () => {
  it("inserts, reads back and reports stored", async () => {
    pgState.replies.push({ rowCount: 1, rows: [] }, { rows: [row()] });
    const sink = createPostgresSink(URL_OK, {});
    const out = await sink.put(REC);
    expect(out).toMatchObject({ status: "stored", record: { chain_seq: 10, head_hash: "h10", row_count: 10 } });
    expect(pgState.queries[0].sql).toMatch(/insert into audit_anchors/);
    expect(pgState.queries[0].sql).toMatch(/on conflict \(workspace_id, chain_seq\) do nothing/);
    expect(pgState.queries[1].sql).toMatch(/select .* from audit_anchors where workspace_id = \$1 and chain_seq = \$2/);
    expect(pgState.ended).toBe(1);
  });
  it("reports exists when the same record is already there", async () => {
    pgState.replies.push({ rowCount: 0, rows: [] }, { rows: [row()] });
    expect((await createPostgresSink(URL_OK, {}).put(REC)).status).toBe("exists");
  });
  it("reports a conflict, not a failure, when the stored hash differs (PR-14)", async () => {
    pgState.replies.push({ rowCount: 0, rows: [] }, { rows: [row({ head_hash: "other" })] });
    const out = await createPostgresSink(URL_OK, {}).put(REC);
    expect(out).toMatchObject({ status: "conflict", stored: { head_hash: "other" } });
  });
  it("fails (and never says stored) when the read-back finds nothing", async () => {
    pgState.replies.push({ rowCount: 1, rows: [] }, { rows: [] });
    expect((await createPostgresSink(URL_OK, {}).put(REC)).status).toBe("failed");
  });
  it("fails without throwing when the connection fails, with a message that leaks nothing", async () => {
    pgState.connectError = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432 postgresql://nopm_anchor:s3cretpw@db.example.test/x"), { code: "ECONNREFUSED" });
    const out = await createPostgresSink(URL_OK, {}).put(REC);
    expect(out.status).toBe("failed");
    const text = JSON.stringify(out);
    expect(text).not.toContain("s3cretpw");
    expect(text).not.toContain("postgresql://");
    expect(text).not.toContain("10.1.2.3");
  });
  it("creates the table on first use when the role may, then retries", async () => {
    pgState.replies.push(Object.assign(new Error("relation does not exist"), { code: "42P01" }), { rowCount: 0 }, { rowCount: 1, rows: [] }, { rows: [row()] });
    const out = await createPostgresSink(URL_OK, {}).put(REC);
    expect(out.status).toBe("stored");
    expect(pgState.queries[1].sql).toBe(ANCHOR_TABLE_SQL);
  });
  it("says what to run when the role may not create the table", async () => {
    pgState.replies.push(Object.assign(new Error("relation does not exist"), { code: "42P01" }), new Error("permission denied for schema public"));
    const out = await createPostgresSink(URL_OK, {}).put(REC);
    expect(out).toMatchObject({ status: "failed" });
    expect((out as { error: string }).error).toContain("001_audit_anchors.sql");
  });
});

describe("postgres sink: latest", () => {
  it("returns the newest record per workspace in ONE query", async () => {
    pgState.replies.push({ rows: [row(), row({ workspace_id: "22222222-2222-4222-8222-222222222222", chain_seq: "3", head_hash: "h3", row_count: "3" })] });
    const out = await createPostgresSink(URL_OK, {}).latest([REC.workspace_id, "22222222-2222-4222-8222-222222222222"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect([...out.records.values()].map((r) => r.chain_seq)).toEqual([10, 3]);
    expect(pgState.queries).toHaveLength(1);
    expect(pgState.queries[0].sql).toMatch(/distinct on \(workspace_id\)/);
  });
  it("asks nothing for no workspaces", async () => {
    expect(await createPostgresSink(URL_OK, {}).latest([])).toEqual({ ok: true, records: new Map() });
    expect(pgState.configs).toHaveLength(0);
  });
  it("returns ok:false instead of throwing when the database is down", async () => {
    pgState.connectError = new Error("timeout");
    expect(await createPostgresSink(URL_OK, {}).latest([REC.workspace_id])).toEqual({ ok: false, error: "timeout" });
  });
});

describe("safeAnchorError", () => {
  it("strips URLs and IP addresses and keeps the code", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54399 via postgres://u:p@h/db"), { code: "ECONNREFUSED" });
    const s = safeAnchorError(e);
    expect(s).not.toMatch(/54399|postgres:\/\/|127\.0/);
    expect(s).toContain("ECONNREFUSED");
  });
  it("is bounded", () => {
    expect(safeAnchorError(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(200);
  });
});
