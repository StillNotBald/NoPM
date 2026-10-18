// NoPM local-DB rehearsal - the wave 5 release, step by step, on the LOCAL stack only (R-180, W5-J).
//
//   cd web && node scripts/local-db/rehearse-wave5.mjs            (full: needs the local app on :3000 for three probes)
//   cd web && node scripts/local-db/rehearse-wave5.mjs --db-only  (database probes only; the three app probes are
//                                                                  reported as SKIPPED BY FLAG and the gate as INCOMPLETE)
//
// What it rehearses (the order of CUTOVER/14-WAVE5-RELEASE.md):
//   1  baseline   row counts, ledger, audit chain verify
//   2  reset      drops the five 0114 triggers (the documented rollback) and removes the ledger rows of 0107 to 0114,
//                 so the local database looks like "before the release" for the runner
//   3  phase 1    dry run, then apply, of 0107 to 0113 ONLY (0114 is held back, exactly as the release script does);
//                 asserts: file count, ROLLED BACK / committed lines, ledger rows, NO delete trigger on the five registers
//   4  gate       the probes that need only the database, run one at a time, in the state the OLD build would see:
//                 atomic-governance (0108), atomic-security (0109), deletion-registers (before 0114), four-eyes, anchor (0112)
//   5  phase 2    dry run, then apply, of 0114 alone with the REAL runner; asserts the ledger, ten enabled triggers
//   6  gate       deletion-registers again (after 0114), then the three probes that need the local app:
//                 atomic-jobs (0110), github, lark
//   7  twice      removes the ledger rows of 0107 to 0114 again and applies the whole range in ONE atomic run over a
//                 database that already holds everything: proves idempotence; compares row counts before and after
//                 (no row may be lost) and verifies the audit chain of every workspace
//
// This answers review finding W1-03 (the atomic converters were proved in vitest only by in-memory mirrors): the
// probes called in steps 4 and 6 run the REAL SQL functions, so a green table here means the SQL itself holds.
//
// SAFETY.
//   - guard.mjs is imported first: every target must be loopback (exit 2 otherwise). Nothing here reads web/.env.local.
//   - It changes the LOCAL ledger and drops/re-creates five LOCAL triggers. Do not run it while another probe run is in
//     flight on the same stack. On any failure it re-applies every pending file so the stack ends at the newest migration.
//   - The runner is copied (byte for byte) into web/node_modules/.rehearse-wave5-<pid>/ together with the migration
//     files minus 0114, because apply-migrations.mjs has no "stop before" option. That folder is removed at the end.
//
// Exit codes: 0 every step and probe PASS (gate complete, or --db-only) - 1 at least one FAIL - 2 guard refused -
// 3 the local Postgres is not running.
import { stack } from "./guard.mjs";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "..");
const migrationsDir = path.join(webDir, "supabase", "migrations");
const dbOnly = process.argv.includes("--db-only");

// ---------------------------------------------------------------- the release shape (CUTOVER/14)
const PHASE1 = ["0107", "0108", "0109", "0110", "0111", "0112", "0113"]; // before the deploy
const PHASE2 = ["0114"]; // after the deploy
const RANGE = [...PHASE1, ...PHASE2];
const HELD_BACK = "20261018000114";
const FIVE_REGISTERS = ["programs", "sprints", "resource_members", "allocations", "clashes"];
const OLD_FIVE = ["risks", "issues", "expenses", "documents", "milestones"];
const TRIGGERS_0114 = FIVE_REGISTERS.map((t) => ({ table: t, name: `trg_${t}_delete_needs_request` }));
const COUNT_TABLES = [
  "audit_log", "change_requests", "deletion_requests", "projects", "tasks", "programs", "sprints",
  "resource_members", "allocations", "clashes", "user_mfa", "workspaces",
];

// ---------------------------------------------------------------- the report
const rows = [];
const t0 = Date.now();
function record(step, check, status, note = "", ms = null) {
  rows.push({ step, check, status, note, ms });
  const tag = status === "PASS" ? "ok  " : status === "SKIP" ? "skip" : "FAIL";
  console.log(`  [${tag}] ${step} ${check}${note ? `  - ${note}` : ""}`);
}
async function step(id, check, fn) {
  const s = Date.now();
  try {
    const note = await fn();
    record(id, check, "PASS", typeof note === "string" ? note : "", Date.now() - s);
    return true;
  } catch (e) {
    record(id, check, "FAIL", String(e?.message ?? e).split("\n")[0].slice(0, 220), Date.now() - s);
    return false;
  }
}
function must(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------- database
const localUrl = new URL(stack.dbUrl);
localUrl.searchParams.set("sslmode", "disable"); // the runner forces TLS otherwise; a sslmode in the URL wins
const runnerDbUrl = localUrl.toString();

let client;
try {
  client = new pg.Client({ connectionString: stack.dbUrl, ssl: false });
  await client.connect();
} catch (e) {
  console.error(`rehearsal: cannot reach the local Postgres at ${new URL(stack.dbUrl).host}: ${e.message}`);
  console.error("Start it first: npx supabase start (see web/scripts/local-db/README.md).");
  process.exit(3);
}
const q = async (text, params) => (await client.query(text, params)).rows;

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const rangeFiles = RANGE.map((n) => files.find((x) => /^\d{8}\d{6}_/.test(x) && x.slice(8, 14) === `00${n}`.slice(-6)));
for (const [i, f] of rangeFiles.entries()) {
  if (!f) {
    console.error(`rehearsal: no migration file for ${RANGE[i]} in ${migrationsDir}`);
    process.exit(1);
  }
}
const phase1Files = rangeFiles.slice(0, PHASE1.length);
const phase2Files = rangeFiles.slice(PHASE1.length);
must(phase2Files.length === 1 && phase2Files[0].startsWith(HELD_BACK), "0114 is not the last file of the range");

async function counts() {
  const out = {};
  for (const t of COUNT_TABLES) out[t] = Number((await q(`select count(*)::bigint as n from ${t}`))[0].n);
  return out;
}
async function ledgerRows(names) {
  return (await q("select name from _nopm_migrations where name = any($1) order by name", [names])).map((r) => r.name);
}
async function deleteTriggers() {
  return q(
    `select c.relname as tbl, t.tgname, t.tgenabled
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname like 'trg\\_%\\_delete\\_needs\\_request' and not t.tgisinternal order by 1`,
  );
}
async function chainState() {
  const v = (await q(
    `select count(*)::int as workspaces, count(*) filter (where not v.ok)::int as bad
       from workspaces w cross join lateral nopm_audit_verify_chain(w.id) v`,
  ))[0];
  const g = (await q(
    `select count(*) filter (where gaps <> 0 or unhashed <> 0)::int as broken from (
       select (max(chain_seq) - min(chain_seq) + 1) - count(*) as gaps, count(*) filter (where row_hash is null) as unhashed
         from audit_log group by workspace_id) s`,
  ))[0];
  return { workspaces: v.workspaces, bad: v.bad, broken: g.broken };
}

// ---------------------------------------------------------------- the runner (real one for phase 2, staged copy for phase 1)
const stageRoot = path.join(webDir, "node_modules", `.rehearse-wave5-${process.pid}`);
function stageRunner() {
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(path.join(stageRoot, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(stageRoot, "supabase", "migrations"), { recursive: true });
  copyFileSync(path.join(webDir, "scripts", "apply-migrations.mjs"), path.join(stageRoot, "scripts", "apply-migrations.mjs"));
  copyFileSync(path.join(webDir, "scripts", "lib", "env.mjs"), path.join(stageRoot, "scripts", "lib", "env.mjs"));
  for (const f of files) {
    if (f.startsWith(HELD_BACK)) continue; // the held-back file
    copyFileSync(path.join(migrationsDir, f), path.join(stageRoot, "supabase", "migrations", f));
  }
  return path.join(stageRoot, "scripts", "apply-migrations.mjs");
}
function runRunner(script, flags) {
  const r = spawnSync(process.execPath, [script, ...flags], {
    cwd: webDir,
    env: { ...process.env, DB_URL: runnerDbUrl },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const realRunner = path.join(webDir, "scripts", "apply-migrations.mjs");
const noisy = /already exists|does not exist, skipping|^skip /;
const lastLines = (s, n = 3) => s.split(/\r?\n/).filter((l) => l.trim() && !noisy.test(l)).slice(-n).join(" | ").slice(0, 200);

// ---------------------------------------------------------------- the probes
function runProbe(file, extraEnv = {}) {
  const s = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, file)], {
    cwd: webDir,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = [...out.matchAll(/(\d+)\/(\d+) passed/g)].pop();
  const totals = m ? `${m[1]}/${m[2]}` : "no totals line";
  const code = r.status;
  const label = { 0: "PASS", 1: "FAIL", 2: "REFUSED by guard", 3: "stack or app down" }[code] ?? `exit ${code}`;
  return { code, totals, label, ms: Date.now() - s, out };
}
async function gateProbe(stepId, file, title, extraEnv) {
  const s = Date.now();
  const res = runProbe(file, extraEnv);
  const ok = res.code === 0;
  record(stepId, `${title}  (${file})`, ok ? "PASS" : "FAIL", `${res.label}, ${res.totals}`, Date.now() - s);
  if (!ok) {
    const bad = res.out.split(/\r?\n/).filter((l) => /FAIL|↳|REFUS|Cannot reach/.test(l)).slice(0, 6);
    for (const l of bad) console.log(`        ${l.slice(0, 200)}`);
  }
  return ok;
}
async function appUp() {
  try {
    const r = await fetch(`${stack.appUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the run
let altered = false;
let before = null;
let ledgerBefore = 0;
try {
  console.log("\n== rehearsal: wave 5 release (0107 to 0114) on the local stack ==\n");

  // 1 baseline -------------------------------------------------------------
  console.log("1 baseline");
  await step("1", "ledger holds 0107 to 0114 and the newest file is 0114", async () => {
    const have = await ledgerRows(rangeFiles);
    must(have.length === rangeFiles.length, `local ledger has ${have.length} of ${rangeFiles.length} files of the range: apply the range once before rehearsing`);
    ledgerBefore = Number((await q("select count(*)::int as n from _nopm_migrations"))[0].n);
    return `${ledgerBefore} ledger rows`;
  });
  await step("1", "row counts recorded", async () => {
    before = await counts();
    return `audit_log ${before.audit_log}, change_requests ${before.change_requests}, deletion_requests ${before.deletion_requests}`;
  });
  await step("1", "audit chain verifies for every workspace before", async () => {
    const c = await chainState();
    must(c.bad === 0 && c.broken === 0, `${c.bad} workspace(s) fail verify, ${c.broken} have a gap or an unhashed row`);
    return `${c.workspaces} workspaces ok`;
  });

  // 2 reset ----------------------------------------------------------------
  console.log("2 reset to the state before the release");
  altered = true;
  await step("2", "0114 rollback: drop the five delete-refusing triggers on the registers", async () => {
    for (const t of TRIGGERS_0114) await client.query(`drop trigger if exists ${t.name} on ${t.table}`);
    const left = (await deleteTriggers()).filter((r) => FIVE_REGISTERS.includes(r.tbl));
    must(left.length === 0, `${left.length} trigger(s) still on the registers`);
    const old = (await deleteTriggers()).filter((r) => OLD_FIVE.includes(r.tbl));
    must(old.length === OLD_FIVE.length, `the five 0102 triggers should stay; found ${old.length}`);
    return "the five 0102 triggers stay";
  });
  await step("2", "remove the ledger rows of 0107 to 0114", async () => {
    await client.query("delete from _nopm_migrations where name = any($1)", [rangeFiles]);
    const have = await ledgerRows(rangeFiles);
    must(have.length === 0, `${have.length} row(s) left`);
    return `${rangeFiles.length} rows removed`;
  });

  // 3 phase 1 --------------------------------------------------------------
  console.log("3 phase 1: 0107 to 0113, 0114 held back");
  const stagedRunner = stageRunner();
  const staged = readdirSync(path.join(stageRoot, "supabase", "migrations"));
  must(!staged.some((f) => f.startsWith(HELD_BACK)), "0114 is in the staged folder");
  await step("3", "dry run: 7 pending files applied cleanly, then ROLLED BACK", async () => {
    const r = runRunner(stagedRunner, ["--atomic", "--dry-run"]);
    must(r.code === 0, `dry run exit ${r.code}: ${lastLines(r.out)}`);
    const m = r.out.match(/(\d+) pending file\(s\) applied cleanly, then ROLLED BACK/);
    must(m, `no ROLLED BACK line: ${lastLines(r.out)}`);
    must(Number(m[1]) === PHASE1.length, `expected ${PHASE1.length} pending files, the dry run counted ${m[1]}`);
    const have = await ledgerRows(rangeFiles);
    must(have.length === 0, "the dry run left ledger rows behind");
    return `${m[1]} files, ledger unchanged`;
  });
  await step("3", "apply: committed 7 files in one transaction", async () => {
    const r = runRunner(stagedRunner, ["--atomic"]);
    must(r.code === 0, `apply exit ${r.code}: ${lastLines(r.out)}`);
    const m = r.out.match(/Committed (\d+) file\(s\) in one transaction/);
    must(m && Number(m[1]) === PHASE1.length, `expected ${PHASE1.length} committed, got ${m ? m[1] : "no Committed line"}`);
    return `${m[1]} files`;
  });
  await step("3", "ledger: 0107 to 0113 present, 0114 absent", async () => {
    const have = await ledgerRows(rangeFiles);
    must(JSON.stringify(have) === JSON.stringify([...phase1Files].sort()), `ledger range rows: ${have.map((n) => n.slice(8, 14)).join(", ")}`);
    return `${have.length} rows`;
  });
  await step("3", "no delete-refusing trigger on the five registers (the old build still deletes)", async () => {
    const t = await deleteTriggers();
    must(t.filter((r) => FIVE_REGISTERS.includes(r.tbl)).length === 0, "a register trigger exists before 0114");
    must(t.length === OLD_FIVE.length, `expected ${OLD_FIVE.length} triggers in total, found ${t.length}`);
    return `${t.length} triggers, all from 0102`;
  });

  // 4 gate before 0114 -------------------------------------------------------
  console.log("4 gate: database probes in the state the old build sees");
  await gateProbe("4", "probe-atomic-governance.mjs", "R-161/R-162 governance writes are atomic with their audit row");
  await gateProbe("4", "probe-atomic-security.mjs", "R-163/R-164 security writes are atomic with their audit row");
  await gateProbe("4", "probe-deletion-registers.mjs", "R-176 deletion by request, BEFORE 0114 (plain DELETE still works)");
  await gateProbe("4", "probe-four-eyes.mjs", "principal-aware four-eyes at the database layer");
  await gateProbe("4", "probe-anchor.mjs", "R-168 to R-170 external audit anchor");

  // 5 phase 2 ---------------------------------------------------------------
  console.log("5 phase 2: 0114 after the deploy");
  await step("5", "dry run with the real runner: exactly 1 pending file (0114), ROLLED BACK", async () => {
    const r = runRunner(realRunner, ["--atomic", "--dry-run"]);
    must(r.code === 0, `dry run exit ${r.code}: ${lastLines(r.out)}`);
    const m = r.out.match(/(\d+) pending file\(s\) applied cleanly, then ROLLED BACK/);
    must(m && Number(m[1]) === PHASE2.length, `expected ${PHASE2.length} pending file, the dry run counted ${m ? m[1] : "no ROLLED BACK line"}`);
    must((await deleteTriggers()).filter((r2) => FIVE_REGISTERS.includes(r2.tbl)).length === 0, "the dry run left a trigger behind");
    return "1 file, nothing changed";
  });
  await step("5", "apply: committed 1 file", async () => {
    const r = runRunner(realRunner, ["--atomic"]);
    must(r.code === 0, `apply exit ${r.code}: ${lastLines(r.out)}`);
    const m = r.out.match(/Committed (\d+) file\(s\) in one transaction/);
    must(m && Number(m[1]) === PHASE2.length, `expected ${PHASE2.length} committed, got ${m ? m[1] : "no Committed line"}`);
    return "1 file";
  });
  await step("5", "ledger complete and ten enabled delete-refusing triggers", async () => {
    const have = await ledgerRows(rangeFiles);
    must(have.length === rangeFiles.length, `ledger holds ${have.length} of ${rangeFiles.length} range files`);
    const n = Number((await q("select count(*)::int as n from _nopm_migrations"))[0].n);
    must(n === ledgerBefore, `ledger has ${n} rows, started with ${ledgerBefore}`);
    const t = await deleteTriggers();
    must(t.length === OLD_FIVE.length + FIVE_REGISTERS.length, `expected 10 triggers, found ${t.length}`);
    must(t.every((r) => r.tgenabled === "O"), "a trigger is not enabled");
    must(FIVE_REGISTERS.every((reg) => t.some((r) => r.tbl === reg)), "a register is missing its trigger");
    return `${n} ledger rows, ${t.length} triggers`;
  });

  // 6 gate after 0114 -------------------------------------------------------
  console.log("6 gate: after 0114");
  await gateProbe("6", "probe-deletion-registers.mjs", "R-176 deletion by request, AFTER 0114 (plain DELETE refused, approvals still work)");
  const appRunning = dbOnly ? false : await appUp();
  const appProbes = [
    ["probe-atomic-jobs.mjs", "R-165 unattended jobs are atomic with their audit row (needs the local app)"],
    ["probe-github.mjs", "R-153 GitHub work events end to end (needs the local app)"],
    ["probe-lark.mjs", "Lark approval cards end to end (needs the local app)"],
  ];
  for (const [file, title] of appProbes) {
    if (dbOnly) {
      record("6", `${title}  (${file})`, "SKIP", "skipped by --db-only");
    } else if (!appRunning) {
      record("6", `${title}  (${file})`, "FAIL", `no app answers at ${stack.appUrl}/api/health: start it (README) or pass --db-only`);
    } else {
      await gateProbe("6", file, title);
    }
  }

  // 7 twice ------------------------------------------------------------------
  console.log("7 the whole range again, in ONE atomic run, over a database that already holds everything");
  await step("7", "remove the ledger rows of 0107 to 0114 again", async () => {
    await client.query("delete from _nopm_migrations where name = any($1)", [rangeFiles]);
    return "8 rows removed, objects and triggers stay";
  });
  await step("7", "apply 0107 to 0114 twice over: committed 8 files in one transaction", async () => {
    const dry = runRunner(realRunner, ["--atomic", "--dry-run"]);
    const dm = dry.out.match(/(\d+) pending file\(s\) applied cleanly, then ROLLED BACK/);
    must(dry.code === 0 && dm && Number(dm[1]) === RANGE.length, `dry run: ${lastLines(dry.out)}`);
    const r = runRunner(realRunner, ["--atomic"]);
    must(r.code === 0, `apply exit ${r.code}: ${lastLines(r.out)}`);
    const m = r.out.match(/Committed (\d+) file\(s\) in one transaction/);
    must(m && Number(m[1]) === RANGE.length, `expected ${RANGE.length} committed, got ${m ? m[1] : "no Committed line"}`);
    altered = false;
    return `${m[1]} files, second run safe`;
  });
  await step("7", "ten enabled triggers and a full ledger after the second run", async () => {
    const t = await deleteTriggers();
    must(t.length === 10 && t.every((r) => r.tgenabled === "O"), `${t.length} triggers`);
    const n = Number((await q("select count(*)::int as n from _nopm_migrations"))[0].n);
    must(n === ledgerBefore, `ledger has ${n} rows, started with ${ledgerBefore}`);
    return `${n} ledger rows`;
  });
  await step("7", "no data lost: every row count after is at least the count before", async () => {
    const after = await counts();
    const lost = COUNT_TABLES.filter((t) => after[t] < before[t]);
    must(lost.length === 0, `lower than before: ${lost.map((t) => `${t} ${before[t]} to ${after[t]}`).join(", ")}`);
    console.log("        table               before     after");
    for (const t of COUNT_TABLES) console.log(`        ${t.padEnd(19)} ${String(before[t]).padStart(6)}  ${String(after[t]).padStart(8)}`);
    return `${COUNT_TABLES.length} tables`;
  });
  await step("7", "audit chain verifies for every workspace after", async () => {
    const c = await chainState();
    must(c.bad === 0 && c.broken === 0, `${c.bad} workspace(s) fail verify, ${c.broken} have a gap or an unhashed row`);
    return `${c.workspaces} workspaces ok`;
  });
} catch (e) {
  record("run", "rehearsal aborted", "FAIL", String(e?.message ?? e).split("\n")[0]);
} finally {
  if (altered) {
    // leave the stack at the newest migration whatever happened above
    const r = runRunner(realRunner, ["--atomic"]);
    console.log(`\n  [restore] re-applied pending files: exit ${r.code} ${lastLines(r.out, 1)}`);
  }
  rmSync(stageRoot, { recursive: true, force: true });
  await client.end().catch(() => {});
}

// ---------------------------------------------------------------- the summary
const failed = rows.filter((r) => r.status === "FAIL").length;
const skipped = rows.filter((r) => r.status === "SKIP").length;
console.log("\n== summary ==");
console.log(`${"STEP".padEnd(4)}  ${"RESULT".padEnd(6)}  ${"CHECK".padEnd(86)}  ${"MS".padStart(6)}  NOTE`);
console.log(`${"-".repeat(4)}  ${"-".repeat(6)}  ${"-".repeat(86)}  ${"-".repeat(6)}  ----`);
for (const r of rows) {
  const check = r.check.length > 86 ? `${r.check.slice(0, 85)}…` : r.check;
  console.log(`${r.step.padEnd(4)}  ${r.status.padEnd(6)}  ${check.padEnd(86)}  ${String(r.ms ?? "").padStart(6)}  ${r.note}`);
}
console.log("");
console.log(`${rows.length - failed - skipped}/${rows.length - skipped} passed${failed ? `, ${failed} FAILED` : ""}${skipped ? `, ${skipped} skipped by --db-only` : ""} in ${Math.round((Date.now() - t0) / 1000)} s`);
if (skipped) console.log("GATE INCOMPLETE: the app probes did not run. Run again without --db-only before the release.");
process.exit(failed ? 1 : 0);
