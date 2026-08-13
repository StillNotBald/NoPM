// cli/test/cli.test.mjs — contract tests for the nopm CLI (node --test, no deps).
//
// Two layers:
//   1. lib/api.mjs unit tests — parseFlags, die, out.
//   2. Command-module contract tests — each command run() with a stubbed ctx;
//      asserts the URL/method/body it builds, and that missing-id guards die
//      BEFORE any API call (the "nopm tasks rm" → DELETE /api/tasks/rm class
//      of bug).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags, die, CliError, out } from "../lib/api.mjs";

// ── Stub ctx ────────────────────────────────────────────────────────────────

function makeCtx(flags, apiResult = { data: [] }) {
  const calls = [];
  return {
    calls,
    flags,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      return apiResult;
    },
    out: () => {},
    die,
    loadConfig: () => ({ url: "http://test", token: "npm_test" }),
  };
}

async function expectDies(fn, pattern) {
  await assert.rejects(fn, (e) => {
    assert.ok(e instanceof CliError, `expected CliError, got ${e.constructor.name}: ${e.message}`);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}

// ── parseFlags ──────────────────────────────────────────────────────────────

test("parseFlags: --flag value", () => {
  assert.deepEqual(parseFlags(["--name", "x"]), { _: [], name: "x" });
});

test("parseFlags: bare --flag is boolean true", () => {
  assert.deepEqual(parseFlags(["--json"]), { _: [], json: true });
});

test("parseFlags: --flag=value (expresses values starting with --)", () => {
  assert.deepEqual(parseFlags(["--reason=--superseded"]), { _: [], reason: "--superseded" });
});

test("parseFlags: -h maps to help", () => {
  assert.deepEqual(parseFlags(["-h"]), { _: [], help: true });
});

test("parseFlags: negative numbers are values, not flags", () => {
  assert.deepEqual(parseFlags(["--lag", "-5"]), { _: [], lag: "-5" });
});

test("parseFlags: positionals collected in order", () => {
  assert.deepEqual(parseFlags(["rm", "task_1", "--reason", "x"]), {
    _: ["rm", "task_1"],
    reason: "x",
  });
});

// ── die ─────────────────────────────────────────────────────────────────────

test("die throws CliError instead of exiting the process", () => {
  assert.throws(() => die("boom", { fields: [] }), (e) => {
    assert.ok(e instanceof CliError);
    assert.equal(e.message, "boom");
    return true;
  });
});

// ── out ─────────────────────────────────────────────────────────────────────

test("out --json prints valid JSON", () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    out([{ id: "1", name: "x" }], { flags: { json: true } });
  } finally {
    console.log = orig;
  }
  assert.deepEqual(JSON.parse(lines.join("\n")), [{ id: "1", name: "x" }]);
});

// ── tasks command contracts ─────────────────────────────────────────────────

test("tasks rm without an id dies BEFORE calling the API", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx({ _: ["rm"], reason: "cleanup" });
  await expectDies(() => tasks.run([], ctx), /usage: nopm tasks rm/);
  assert.equal(ctx.calls.length, 0, "no API call may fire without an id");
});

test("tasks rm with an id sends DELETE /api/tasks/<id> with the reason", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx({ _: ["rm", "task_1"], reason: "dup" }, { data: { id: "dr_1" } });
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "DELETE", path: "/api/tasks/task_1", body: { reason: "dup" } },
  ]);
});

test("tasks update builds a PATCH with only the supplied fields", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx({ _: ["update", "task_9"], "status-type": "started" }, { data: { id: "task_9" } });
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/tasks/task_9", body: { status_type: "started" } },
  ]);
});

// ── approve command contracts ───────────────────────────────────────────────

test("approve reject without an id dies BEFORE calling the API", async () => {
  const approve = await import("../commands/approve.mjs");
  const ctx = makeCtx({ _: ["reject"] });
  await expectDies(() => approve.run([], ctx), /usage: nopm approve reject/);
  assert.equal(ctx.calls.length, 0, "no API call may fire without an id");
});

test("approve <id> posts to /approve", async () => {
  const approve = await import("../commands/approve.mjs");
  const ctx = makeCtx({ _: ["dr_7"] }, { data: { id: "dr_7", status: "committed" } });
  await approve.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "POST", path: "/api/deletion-requests/dr_7/approve", body: undefined },
  ]);
});

test("approve without an id dies", async () => {
  const approve = await import("../commands/approve.mjs");
  const ctx = makeCtx({ _: [] });
  await expectDies(() => approve.run([], ctx), /usage: nopm approve/);
  assert.equal(ctx.calls.length, 0);
});

// ── every command module exposes the help contract ──────────────────────────

test("every command module exports describe + usage + run", async () => {
  const { readdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "commands");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 24, `expected >= 24 command modules, found ${files.length}`);
  for (const f of files) {
    const mod = await import(`../commands/${f}`);
    assert.equal(typeof mod.describe, "string", `${f}: missing describe`);
    assert.ok(Array.isArray(mod.usage), `${f}: missing usage[]`);
    assert.equal(typeof mod.run, "function", `${f}: missing run()`);
  }
});
