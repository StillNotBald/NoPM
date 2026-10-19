import pg, { type Client, type ClientConfig } from "pg";
import { ANCHOR_TABLE_SQL } from "./bootstrap-sql";
import { AnchorSafeError, safeAnchorError, type AnchorRecord, type AnchorSink, type LatestResult, type PutResult } from "./sink";

/**
 * The Postgres anchor sink (R-168): a SECOND database, reached by NOPM_ANCHOR_DB_URL, holding the
 * append-only table audit_anchors. `pg` (already approved, typed by src/types/pg-shim.d.ts) is
 * imported here and nowhere else in the app.
 *
 * Each call opens ONE short-lived client and closes it, with a 5 s connect timeout and a 5 s
 * statement timeout. TLS is always on and the certificate IS verified (a forged "latest" from a
 * network attacker would otherwise hide a mismatch); NOPM_ANCHOR_SSL_VERIFY=0 opts out for a provider
 * whose CA the runtime does not trust. TLS may be switched off only for a loopback host AND
 * NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK=1, which the local rehearsal sets and production never does.
 *
 * The table is created on first use ONLY when NOPM_ANCHOR_BOOTSTRAP=1 (a rehearsal with an owner
 * role). With the production insert-and-select role, or without the flag, a missing table is an
 * error that names the file to run: the app must never hold a role that can drop the append-only
 * trigger (D12).
 *
 * `latest` honours a `reset` row (CUTOVER/13): the newest row with source = 'reset' is the baseline
 * and rows inserted before it are history, so after a legitimate restore the owner can re-baseline;
 * anything that diverges AFTER the reset is still a mismatch.
 *
 * A connection string is never logged or returned: errors pass through safeAnchorError.
 */
export const ANCHOR_CONNECT_TIMEOUT_MS = 5_000;
export const ANCHOR_STATEMENT_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/** pg client options for a URL, or an error text when the URL is unusable. Pure, so it is unit tested. */
export function anchorClientConfig(url: string, env: Env = process.env): { config: ClientConfig } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "NOPM_ANCHOR_DB_URL is not a valid URL" };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { error: "NOPM_ANCHOR_DB_URL must be a postgres:// or postgresql:// URL" };
  }
  // The driver must not let a sslmode in the URL override the explicit setting below.
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("ssl");
  const plaintext = env.NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK === "1" && isLoopbackHost(parsed.hostname);
  return {
    config: {
      connectionString: parsed.toString(),
      ssl: plaintext ? false : { rejectUnauthorized: env.NOPM_ANCHOR_SSL_VERIFY !== "0" },
      connectionTimeoutMillis: ANCHOR_CONNECT_TIMEOUT_MS,
      statement_timeout: ANCHOR_STATEMENT_TIMEOUT_MS,
      query_timeout: ANCHOR_STATEMENT_TIMEOUT_MS,
      application_name: "nopm-audit-anchor",
    },
  };
}

type Row = {
  workspace_id: string;
  chain_seq: string | number;
  head_hash: string;
  row_count: string | number;
  anchored_at: Date | string;
  source?: string;
  reset_at?: Date | string | null;
};

function toRecord(r: Row): AnchorRecord {
  return {
    workspace_id: r.workspace_id,
    chain_seq: Number(r.chain_seq),
    head_hash: r.head_hash,
    row_count: Number(r.row_count),
    anchored_at: r.anchored_at instanceof Date ? r.anchored_at.toISOString() : new Date(r.anchored_at).toISOString(),
    source: r.source ?? "nopm",
    baseline_reset_at: r.reset_at == null ? null : r.reset_at instanceof Date ? r.reset_at.toISOString() : new Date(r.reset_at).toISOString(),
  };
}

const COLUMNS = "workspace_id::text as workspace_id, chain_seq, head_hash, row_count, anchored_at, source";

export function createPostgresSink(url: string, env: Env = process.env): AnchorSink {
  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const cfg = anchorClientConfig(url, env);
    if ("error" in cfg) throw new AnchorSafeError(cfg.error);
    const client = new pg.Client(cfg.config);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Run `fn`; when the table is missing, try the bootstrap once (works for an owner role) and retry. */
  async function withTable<T>(c: Client, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code !== "42P01") throw err;
      if (env.NOPM_ANCHOR_BOOTSTRAP !== "1") {
        throw new AnchorSafeError("the audit_anchors table does not exist: run web/anchor-db/001_audit_anchors.sql once as the anchor database owner");
      }
      try {
        await c.query(ANCHOR_TABLE_SQL);
      } catch {
        throw new AnchorSafeError("the audit_anchors table does not exist and this role cannot create it: run web/anchor-db/001_audit_anchors.sql as the owner");
      }
      return fn();
    }
  }

  return {
    kind: "postgres",

    async put(record: AnchorRecord): Promise<PutResult> {
      try {
        return await withClient((c) =>
          withTable(c, async (): Promise<PutResult> => {
            const ins = await c.query(
              `insert into audit_anchors (workspace_id, chain_seq, head_hash, row_count, anchored_at, source)
               values ($1, $2, $3, $4, $5, 'nopm')
               on conflict (workspace_id, chain_seq) where source <> 'reset' do nothing`,
              [record.workspace_id, record.chain_seq, record.head_hash, record.row_count, record.anchored_at],
            );
            // Read it back: the comparison, not the insert, is what makes this an anchor.
            const back = await c.query<Row>(
              `select ${COLUMNS} from audit_anchors where workspace_id = $1 and chain_seq = $2 and source <> 'reset'`,
              [record.workspace_id, record.chain_seq],
            );
            const stored = back.rows[0] ? toRecord(back.rows[0]) : null;
            if (!stored) return { status: "failed", error: "the anchor was written but could not be read back" };
            if (stored.head_hash !== record.head_hash) return { status: "conflict", stored };
            return { status: (ins.rowCount ?? 0) > 0 ? "stored" : "exists", record: stored };
          }),
        );
      } catch (err) {
        return { status: "failed", error: safeAnchorError(err) };
      }
    },

    async latest(workspaceIds: readonly string[]): Promise<LatestResult> {
      if (workspaceIds.length === 0) return { ok: true, records: new Map() };
      try {
        return await withClient((c) =>
          withTable(c, async (): Promise<LatestResult> => {
            const res = await c.query<Row>(
              `with base as (
                 select distinct on (workspace_id) workspace_id, id as rid, recorded_at as reset_at
                   from audit_anchors
                  where source = 'reset' and workspace_id = any($1::uuid[])
                  order by workspace_id, id desc
               )
               select distinct on (a.workspace_id)
                      a.workspace_id::text as workspace_id, a.chain_seq, a.head_hash, a.row_count, a.anchored_at, a.source, b.reset_at
                 from audit_anchors a
                 left join base b on b.workspace_id = a.workspace_id
                where a.workspace_id = any($1::uuid[]) and (b.rid is null or a.id >= b.rid)
                order by a.workspace_id, a.chain_seq desc`,
              [workspaceIds],
            );
            return { ok: true, records: new Map(res.rows.map((r) => [r.workspace_id, toRecord(r)])) };
          }),
        );
      } catch (err) {
        return { ok: false, error: safeAnchorError(err) };
      }
    },
  };
}
