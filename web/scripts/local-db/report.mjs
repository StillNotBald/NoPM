// NoPM local-DB probes — tiny PASS/FAIL recorder shared by every probe.
//
// Design rule (feedback: "absent checks look like passes"): there is NO skip
// state. A check that cannot run because a prerequisite is missing is a FAIL
// with the reason, never a silent omission — a green table must mean every
// listed rule was actually exercised.

export class AssertionFailure extends Error {}

/** Throw an AssertionFailure unless `cond` holds. */
export function expect(cond, message) {
  if (!cond) throw new AssertionFailure(message);
}

/** Deep-ish equality for small JSON values (primitives, arrays, plain objects). */
export function expectEqual(actual, wanted, message) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(wanted);
  if (a !== w) throw new AssertionFailure(`${message} (wanted ${w}, got ${a})`);
}

/** Flatten a supabase-js / pg / fetch error into one searchable string. */
export function errText(err) {
  if (!err) return "";
  return [err.message, err.code, err.details, err.hint, err.constraint]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .join(" | ");
}

export function createReport(title) {
  const rows = [];

  async function check(id, description, fn) {
    try {
      const note = await fn();
      rows.push({ id, description, status: "PASS", note: typeof note === "string" ? note : "" });
    } catch (e) {
      const note = e instanceof AssertionFailure ? e.message : `${e?.name ?? "Error"}: ${e?.message ?? e}`;
      rows.push({ id, description, status: "FAIL", note });
    }
  }

  /** Record a failure for a block that could not even start (e.g. missing prerequisite). */
  function fail(id, description, note) {
    rows.push({ id, description, status: "FAIL", note });
  }

  function finish() {
    const idW = Math.max(2, ...rows.map((r) => r.id.length));
    const descW = Math.min(78, Math.max(11, ...rows.map((r) => r.description.length)));
    console.log("");
    console.log(`== ${title} ==`);
    console.log(`${"ID".padEnd(idW)}  ${"RESULT".padEnd(6)}  ${"CHECK".padEnd(descW)}`);
    console.log(`${"-".repeat(idW)}  ${"-".repeat(6)}  ${"-".repeat(descW)}`);
    for (const r of rows) {
      const d = r.description.length > descW ? r.description.slice(0, descW - 1) + "…" : r.description;
      console.log(`${r.id.padEnd(idW)}  ${r.status.padEnd(6)}  ${d.padEnd(descW)}`);
      if (r.note) console.log(`${" ".repeat(idW + 2)}  ${" ".repeat(6)}  ↳ ${r.note}`);
    }
    const failed = rows.filter((r) => r.status === "FAIL").length;
    console.log("");
    console.log(`${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ""}`);
    if (failed) {
      process.exitCode = 1;
    }
    return failed === 0;
  }

  return { check, fail, finish, rows };
}
