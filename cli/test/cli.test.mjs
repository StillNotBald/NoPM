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

// ── complement seam (0041, R-81) — --source/--external-ref/--external-url ──

test("tasks create includes source/external-ref/external-url when supplied", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx(
    { _: ["create"], project: "proj_1", name: "Wire up billing", source: "jira", "external-ref": "PROJ-123", "external-url": "https://example.atlassian.net/browse/PROJ-123" },
    { data: { id: "task_1" } },
  );
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    {
      method: "POST",
      path: "/api/projects/proj_1/tasks",
      body: {
        name: "Wire up billing",
        source: "jira",
        external_ref: "PROJ-123",
        external_url: "https://example.atlassian.net/browse/PROJ-123",
      },
    },
  ]);
});

test("tasks ls passes --external-ref through as a query filter", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx({ _: ["ls"], project: "proj_1", "external-ref": "PROJ-123" });
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "GET", path: "/api/projects/proj_1/tasks?page=1&limit=100&external_ref=PROJ-123", body: undefined },
  ]);
});

test("projects create includes source/external-ref/external-url when supplied", async () => {
  const projects = await import("../commands/projects.mjs");
  const ctx = makeCtx(
    { _: ["create"], name: "Apollo", code: "APOLLO", source: "jira", "external-ref": "APOLLO-EPIC" },
    { data: { id: "proj_1" } },
  );
  await projects.run([], ctx);
  assert.deepEqual(ctx.calls, [
    {
      method: "POST",
      path: "/api/projects",
      body: { name: "Apollo", code: "APOLLO", source: "jira", external_ref: "APOLLO-EPIC" },
    },
  ]);
});

test("risks update includes source/external-ref/external-url when supplied", async () => {
  const risks = await import("../commands/risks.mjs");
  const ctx = makeCtx(
    { _: ["update", "risk_1"], source: "jira", "external-ref": "RISK-9" },
    { data: { id: "risk_1" } },
  );
  await risks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/risks/risk_1", body: { source: "jira", external_ref: "RISK-9" } },
  ]);
});

test("issues create includes source/external-ref/external-url when supplied", async () => {
  const issues = await import("../commands/issues.mjs");
  const ctx = makeCtx(
    { _: ["create"], project: "proj_1", title: "Bug", priority: "high", source: "jira", "external-ref": "BUG-9" },
    { data: { id: "issue_1" } },
  );
  await issues.run([], ctx);
  assert.deepEqual(ctx.calls, [
    {
      method: "POST",
      path: "/api/projects/proj_1/issues",
      body: { title: "Bug", priority: "high", source: "jira", external_ref: "BUG-9" },
    },
  ]);
});

test("decisions create includes source/external-ref/external-url when supplied", async () => {
  const decisions = await import("../commands/decisions.mjs");
  const ctx = makeCtx(
    { _: ["create"], project: "proj_1", title: "Use Postgres", decision: "Use PostgreSQL", source: "slack", "external-ref": "C123/p456" },
    { data: { id: "dec_1" } },
  );
  await decisions.run([], ctx);
  assert.deepEqual(ctx.calls, [
    {
      method: "POST",
      path: "/api/projects/proj_1/decisions",
      body: { title: "Use Postgres", decision: "Use PostgreSQL", source: "slack", external_ref: "C123/p456" },
    },
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
