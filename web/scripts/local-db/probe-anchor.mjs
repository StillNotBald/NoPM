// NoPM local-DB probe — the external audit anchor (W5-E, R-168..R-170).
//
//   cd web && node scripts/local-db/probe-anchor.mjs
//
// Needs only the LOCAL Postgres of the Supabase stack (127.0.0.1:54322). It creates a SECOND DATABASE
// `nopm_anchor` and a role `nopm_anchor` (INSERT + SELECT only) INSIDE that same server: no new
// container, nothing on port 54329. It then drives the real sink module (src/lib/audit/anchor, loaded
// straight from the TypeScript sources by Node's type stripping) against it, using a real audit chain
// head read from the primary database, and proves:
//
//   P1  unset NOPM_ANCHOR_DB_URL -> sink "none": nothing written, nothing thrown, state not_anchored
//   P2  first anchor is stored and read back; the live chain compares as `anchored`
//   P3  a later anchor (the newer real head) is stored; the newest one wins; older head reads `behind`
//   P4  anchoring the same head again is `exists`, not an error
//   P5  the app role cannot UPDATE, DELETE or TRUNCATE (permission or the append-only trigger)
//   P6  tamper: the owner rewrites a stored hash -> the live chain compares as `mismatch`
//   P7  a second record at the same chain_seq with a different hash is a `conflict` (counts as mismatch)
//   P8  live chain shorter than the anchor (rows deleted) -> `mismatch`
//   P9  an unreachable anchor database (closed loopback port) -> `failed` / not ok, fast, and the error
//       text contains neither the URL, the password nor the port
//
// It refuses any non-loopback URL (exit 2). It never touches the primary database except to READ one
// audit chain head. Anchor rows are keyed by a fresh random workspace id each run, so re-runs are clean.
// Exit codes: 0 all pass, 1 a check failed, 2 refused, 3 the local Postgres is not running.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "..");
const srcDir = path.join(webDir, "src");

const PRIMARY = process.env.LOCAL_PG_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const APP_PASSWORD = "anchor-local-only";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function refuse(msg) {
  console.error(`\nanchor probe REFUSED: ${msg}\n`);
  process.exit(2);
}
if (!LOOPBACK.has(new URL(PRIMARY).hostname)) refuse("LOCAL_PG_URL must be a loopback address");
const host = new URL(PRIMARY).hostname;
const port = new URL(PRIMARY).port || "5432";
const adminUrl = (db) => {
  const u = new URL(PRIMARY);
  u.pathname = `/${db}`;
  u.searchParams.set("sslmode", "disable");
  return u.toString();
};
const appUrl = `postgresql://nopm_anchor:${APP_PASSWORD}@${host}:${port}/nopm_anchor`;

// Load the TypeScript sources directly: resolve "@/..." and extensionless relative imports to .ts files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;
    if (spec.startsWith("@/")) spec = pathToFileURL(path.join(srcDir, spec.slice(2))).href;
    if (spec.startsWith("file:") || spec.startsWith(".")) {
      const base = spec.startsWith("file:") ? spec : new URL(spec, context.parentURL).href;
      const p = fileURLToPath(base);
      for (const cand of [p, `${p}.ts`, path.join(p, "index.ts")]) {
        if (existsSync(cand) && statSync(cand).isFile()) return nextResolve(pathToFileURL(cand).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const anchorDir = path.join(srcDir, "lib", "audit", "anchor");
const { getAnchorSink } = await import(pathToFileURL(path.join(anchorDir, "get-sink.ts")).href);
const { createPostgresSink } = await import(pathToFileURL(path.join(anchorDir, "postgres-sink.ts")).href);
const { compareAnchor } = await import(pathToFileURL(path.join(anchorDir, "compare.ts")).href);

let failed = 0;
const rows = [];
async function check(id, what, fn) {
  try {
    const detail = await fn();
    rows.push([id, "PASS", what, detail ?? ""]);
  } catch (e) {
    failed += 1;
    rows.push([id, "FAIL", what, e instanceof Error ? e.message : String(e)]);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ── setup: second database + role inside the existing local Postgres ─────────────────────────────
const boot = new pg.Client({ connectionString: adminUrl("postgres") });
try {
  await boot.connect();
} catch {
  console.error("The local Postgres is not reachable on " + host + ":" + port + ". Start the Supabase stack first.");
  process.exit(3);
}
const hasDb = (await boot.query("select 1 from pg_database where datname = 'nopm_anchor'")).rowCount > 0;
if (!hasDb) await boot.query("create database nopm_anchor");
const hasRole = (await boot.query("select 1 from pg_roles where rolname = 'nopm_anchor'")).rowCount > 0;
if (!hasRole) await boot.query(`create role nopm_anchor login password '${APP_PASSWORD}'`);
await boot.end();

const owner = new pg.Client({ connectionString: adminUrl("nopm_anchor") });
await owner.connect();
await owner.query(readFileSync(path.join(webDir, "anchor-db", "001_audit_anchors.sql"), "utf8"));
await owner.query("grant connect on database nopm_anchor to nopm_anchor");
await owner.query("grant usage on schema public to nopm_anchor");
await owner.query(readFileSync(path.join(webDir, "anchor-db", "001_audit_anchors.sql"), "utf8")); // grants now that the role exists

// A real chain head from the primary database (read only).
const primary = new pg.Client({ connectionString: adminUrl("postgres") });
await primary.connect();
const heads = (
  await primary.query(
    `select workspace_id::text as ws, max(chain_seq) as head from audit_log where row_hash is not null group by workspace_id order by head desc limit 1`,
  )
).rows[0];
if (!heads) {
  console.error("No audit chain rows in the local primary database; run the app or a seed first.");
  process.exit(3);
}
const live = async (seq) =>
  (await primary.query("select row_hash from audit_log where workspace_id = $1 and chain_seq = $2", [heads.ws, seq])).rows[0]?.row_hash ?? null;
const headSeq = Number(heads.head);
const prevSeq = headSeq - 1;
const headHash = await live(headSeq);
const prevHash = await live(prevSeq);
await primary.end();
if (!headHash || !prevHash) {
  console.error("The chosen workspace has no consecutive hashed rows; cannot rehearse.");
  process.exit(3);
}

const WS = randomUUID(); // anchor rows are keyed by a fresh id per run; the LIVE side is the real chain
const env = { NOPM_ANCHOR_DB_URL: appUrl, NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK: "1" };
const sink = createPostgresSink(appUrl, env);
const rec = (seq, hash) => ({ workspace_id: WS, chain_seq: seq, head_hash: hash, row_count: seq, anchored_at: new Date().toISOString() });

await check("P1", "unset NOPM_ANCHOR_DB_URL is sink none: writes nothing, throws nothing, not_anchored", async () => {
  const none = getAnchorSink({});
  expect(none.kind === "none", `kind was ${none.kind}`);
  const put = await none.put(rec(headSeq, headHash));
  expect(put.status === "disabled", `put was ${put.status}`);
  const latest = await none.latest([WS]);
  expect(latest.ok && latest.records.size === 0, "latest was not empty");
  expect(compareAnchor(null, { headSeq, hashAtAnchorSeq: headHash }).state === "not_anchored", "state was not not_anchored");
  return "kind none, put disabled, state not_anchored";
});

await check("P2", "first anchor is stored, read back, and the live chain compares as anchored", async () => {
  const put = await sink.put(rec(prevSeq, prevHash));
  expect(put.status === "stored", `put was ${put.status} ${put.error ?? ""}`);
  const latest = await sink.latest([WS]);
  expect(latest.ok && latest.records.get(WS)?.chain_seq === prevSeq, "latest did not return the first anchor");
  const st = compareAnchor(latest.records.get(WS), { headSeq: prevSeq, hashAtAnchorSeq: prevHash });
  expect(st.state === "anchored", `state ${st.state}`);
  return `anchored at chain_seq ${prevSeq}`;
});

await check("P3", "second anchor with new rows: newest wins; the older anchor now reads behind", async () => {
  const before = compareAnchor((await sink.latest([WS])).records.get(WS), { headSeq, hashAtAnchorSeq: prevHash });
  expect(before.state === "behind" && before.rows_behind === headSeq - prevSeq, `before: ${before.state} ${before.rows_behind}`);
  const put = await sink.put(rec(headSeq, headHash));
  expect(put.status === "stored", `put was ${put.status}`);
  const latest = (await sink.latest([WS])).records.get(WS);
  expect(latest.chain_seq === headSeq, "newest anchor was not the head");
  const st = compareAnchor(latest, { headSeq, hashAtAnchorSeq: headHash });
  expect(st.state === "anchored", `state ${st.state}`);
  return `behind by ${before.rows_behind} -> anchored at ${headSeq}`;
});

await check("P4", "anchoring the same head again is exists, not an error", async () => {
  const put = await sink.put(rec(headSeq, headHash));
  expect(put.status === "exists", `put was ${put.status}`);
});

await check("P5", "the app role cannot UPDATE, DELETE or TRUNCATE the anchor table", async () => {
  const app = new pg.Client({ connectionString: appUrl, ssl: false });
  await app.connect();
  const refused = [];
  for (const sql of [
    `update audit_anchors set head_hash = 'x' where workspace_id = '${WS}'`,
    `delete from audit_anchors where workspace_id = '${WS}'`,
    "truncate audit_anchors",
  ]) {
    try {
      await app.query(sql);
      throw new Error(`was allowed: ${sql}`);
    } catch (e) {
      if (String(e.message).startsWith("was allowed")) throw e;
      refused.push(e.code ?? "error");
    }
  }
  await app.end();
  return `refused (${refused.join(", ")})`;
});

await check("P6", "tamper: the owner rewrites the stored hash -> the live chain compares as mismatch", async () => {
  await owner.query("alter table audit_anchors disable trigger audit_anchors_no_change");
  await owner.query("update audit_anchors set head_hash = $1 where workspace_id = $2 and chain_seq = $3", ["0".repeat(64), WS, headSeq]);
  await owner.query("alter table audit_anchors enable trigger audit_anchors_no_change");
  const latest = (await sink.latest([WS])).records.get(WS);
  const st = compareAnchor(latest, { headSeq, hashAtAnchorSeq: headHash });
  expect(st.state === "mismatch", `state ${st.state}`);
  return st.reason;
});

await check("P7", "a second record at the same chain_seq with a different hash is a conflict", async () => {
  const put = await sink.put(rec(headSeq, headHash)); // stored hash is now the tampered one
  expect(put.status === "conflict", `put was ${put.status}`);
  expect(put.stored.head_hash === "0".repeat(64), "conflict did not return the stored record");
});

await check("P8", "live chain shorter than the anchor (newest rows deleted) -> mismatch", async () => {
  const latest = (await sink.latest([WS])).records.get(WS);
  const st = compareAnchor(latest, { headSeq: headSeq - 3, hashAtAnchorSeq: null });
  expect(st.state === "mismatch", `state ${st.state}`);
  return st.reason;
});

await check("P9", "unreachable anchor database -> failed, fast, and the error leaks no URL, password or port", async () => {
  const dead = `postgresql://nopm_anchor:${APP_PASSWORD}@127.0.0.1:54399/nopm_anchor`;
  const t0 = Date.now();
  const deadSink = createPostgresSink(dead, env);
  const put = await deadSink.put(rec(headSeq, headHash));
  const latest = await deadSink.latest([WS]);
  const ms = Date.now() - t0;
  expect(put.status === "failed", `put was ${put.status}`);
  expect(latest.ok === false, "latest reported ok");
  const text = `${put.error} ${latest.error}`;
  expect(!text.includes(APP_PASSWORD) && !text.includes("54399") && !text.includes("postgresql://"), `error leaks: ${text}`);
  expect(ms < 15_000, `took ${ms} ms`);
  return `failed in ${ms} ms: ${put.error}`;
});

await owner.end();

const pad = (s, n) => String(s).padEnd(n);
console.log("\nAnchor probe (second database nopm_anchor inside the local Postgres)\n");
for (const [id, verdict, what, detail] of rows) console.log(`${pad(id, 3)} ${pad(verdict, 5)} ${what}${detail ? `\n          ${detail}` : ""}`);
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
