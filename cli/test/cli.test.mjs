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
import { parseFlags, die, CliError, out, api } from "../lib/api.mjs";

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
    { method: "GET", path: "/api/projects/proj_1/tasks?page=1&limit=100&view=full&external_ref=PROJ-123", body: undefined },
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

// ── audit command contracts (R-85 cursor params) ────────────────────────────

test("audit ls builds a GET with default limit/page and no cursor params", async () => {
  const audit = await import("../commands/audit.mjs");
  const ctx = makeCtx({ _: [] });
  await audit.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "GET", path: "/api/audit?limit=20&page=1", body: undefined },
  ]);
});

test("audit ls passes --since/--after-id/--order/--channel through as query params", async () => {
  const audit = await import("../commands/audit.mjs");
  const ctx = makeCtx({
    _: [],
    since: "2026-09-01T00:00:00Z",
    "after-id": "aud_1",
    order: "asc",
    channel: "cli",
  });
  await audit.run([], ctx);
  assert.deepEqual(ctx.calls, [
    {
      method: "GET",
      path: "/api/audit?limit=20&page=1&channel=cli&since=2026-09-01T00%3A00%3A00Z&after_id=aud_1&order=asc",
      body: undefined,
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

test("approve withdraw <id> posts to /withdraw; without an id it dies before any call", async () => {
  const approve = await import("../commands/approve.mjs");
  const ctx = makeCtx({ _: ["withdraw", "dr_9"] }, { data: { withdrawn: true } });
  await approve.run([], ctx);
  assert.deepEqual(ctx.calls, [{ method: "POST", path: "/api/deletion-requests/dr_9/withdraw", body: undefined }]);
  const bare = makeCtx({ _: ["withdraw"] });
  await expectDies(() => approve.run([], bare), /usage: nopm approve withdraw/);
  assert.equal(bare.calls.length, 0);
});

test("approve without an id dies", async () => {
  const approve = await import("../commands/approve.mjs");
  const ctx = makeCtx({ _: [] });
  await expectDies(() => approve.run([], ctx), /usage: nopm approve/);
  assert.equal(ctx.calls.length, 0);
});

// ── changes command contracts (status is a four-eyes decision) ──────────────

test("changes create: --status accepts only raised|under_review", async () => {
  const changes = await import("../commands/changes.mjs");
  for (const status of ["raised", "under_review"]) {
    const ctx = makeCtx({ _: ["create"], project: "proj_1", title: "Add SSO", status }, { data: { id: "cr_1", reference_id: "CR-1" } });
    await changes.run([], ctx);
    assert.deepEqual(ctx.calls, [
      { method: "POST", path: "/api/projects/proj_1/change-requests", body: { title: "Add SSO", status } },
    ]);
  }
});

test("changes decide: fetches the request first and sends its updated_at as expected_updated_at", async () => {
  const changes = await import("../commands/changes.mjs");
  const ctx = makeCtx({ _: ["decide", "cr_1"], decision: "approve", rationale: "ok" }, { data: { id: "cr_1", status: "approved", updated_at: "2026-10-17T10:00:00Z" } });
  await changes.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "GET", path: "/api/change-requests/cr_1", body: undefined },
    { method: "POST", path: "/api/change-requests/cr_1/decision", body: { decision: "approve", rationale: "ok", expected_updated_at: "2026-10-17T10:00:00Z" } },
  ]);
});

test("changes create: a decided status dies BEFORE the API call and points at `changes decide`", async () => {
  const changes = await import("../commands/changes.mjs");
  for (const status of ["approved", "rejected", "deferred", "implemented"]) {
    const ctx = makeCtx({ _: ["create"], project: "proj_1", title: "Add SSO", status });
    await expectDies(() => changes.run([], ctx), /raised or under_review[\s\S]*nopm changes decide/);
    assert.equal(ctx.calls.length, 0, `--status ${status} must not reach the API`);
  }
});

test("changes update: --status dies BEFORE the API call and points at `changes decide`", async () => {
  const changes = await import("../commands/changes.mjs");
  const ctx = makeCtx({ _: ["update", "cr_1"], status: "approved", title: "x" });
  await expectDies(() => changes.run([], ctx), /nopm changes decide/);
  assert.equal(ctx.calls.length, 0);
});

test("changes update: other fields still PATCH, and the body never carries a status", async () => {
  const changes = await import("../commands/changes.mjs");
  const ctx = makeCtx({ _: ["update", "cr_1"], title: "Renamed", priority: "high" }, { data: { id: "cr_1" } });
  await changes.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/change-requests/cr_1", body: { title: "Renamed", priority: "high" } },
  ]);
});

test("changes help: update no longer lists --status, create lists only raised|under_review, decide is named", async () => {
  const changes = await import("../commands/changes.mjs");
  const lines = changes.usage;
  const update = lines.find((l) => l.startsWith("nopm changes update"));
  assert.ok(update && !update.includes("--status"), "update must not advertise --status");
  const create = lines.find((l) => l.startsWith("nopm changes create"));
  assert.ok(create?.includes("--status"));
  const legend = lines.find((l) => l.trim().startsWith("status:"));
  assert.match(legend, /raised \| under_review/);
  assert.doesNotMatch(legend, /approved|rejected|deferred|implemented/);
  assert.match(legend, /nopm changes decide/);
});

// ── optimistic concurrency (R-90) — --expected-updated-at ───────────────────

test("projects update sends expected_updated_at when the flag is supplied", async () => {
  const projects = await import("../commands/projects.mjs");
  const ctx = makeCtx(
    { _: ["update", "proj_1"], rag: "amber", "expected-updated-at": "2026-09-01T00:00:00Z" },
    { data: { id: "proj_1" } },
  );
  await projects.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/projects/proj_1", body: { rag_status: "amber", expected_updated_at: "2026-09-01T00:00:00Z" } },
  ]);
});

test("tasks update sends expected_updated_at when the flag is supplied", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx(
    { _: ["update", "task_1"], "status-type": "completed", "expected-updated-at": "2026-09-01T00:00:00Z" },
    { data: { id: "task_1" } },
  );
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/tasks/task_1", body: { status_type: "completed", expected_updated_at: "2026-09-01T00:00:00Z" } },
  ]);
});

test("tasks update omits expected_updated_at when the flag is not supplied", async () => {
  const tasks = await import("../commands/tasks.mjs");
  const ctx = makeCtx({ _: ["update", "task_1"], "status-type": "completed" }, { data: { id: "task_1" } });
  await tasks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/tasks/task_1", body: { status_type: "completed" } },
  ]);
  assert.ok(!("expected_updated_at" in ctx.calls[0].body), "expected_updated_at must not appear unless the flag was given");
});

test("milestones update sends expected_updated_at when the flag is supplied", async () => {
  const milestones = await import("../commands/milestones.mjs");
  const ctx = makeCtx(
    { _: ["update", "ms_1"], status: "at_risk", "expected-updated-at": "2026-09-01T00:00:00Z" },
    { data: { id: "ms_1" } },
  );
  await milestones.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/milestones/ms_1", body: { status: "at_risk", expected_updated_at: "2026-09-01T00:00:00Z" } },
  ]);
});

test("risks update sends expected_updated_at when the flag is supplied", async () => {
  const risks = await import("../commands/risks.mjs");
  const ctx = makeCtx(
    { _: ["update", "risk_1"], status: "mitigating", "expected-updated-at": "2026-09-01T00:00:00Z" },
    { data: { id: "risk_1" } },
  );
  await risks.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/risks/risk_1", body: { status: "mitigating", expected_updated_at: "2026-09-01T00:00:00Z" } },
  ]);
});

test("issues update sends expected_updated_at when the flag is supplied", async () => {
  const issues = await import("../commands/issues.mjs");
  const ctx = makeCtx(
    { _: ["update", "issue_1"], status: "in_progress", "expected-updated-at": "2026-09-01T00:00:00Z" },
    { data: { id: "issue_1" } },
  );
  await issues.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "PATCH", path: "/api/issues/issue_1", body: { status: "in_progress", expected_updated_at: "2026-09-01T00:00:00Z" } },
  ]);
});

test("issues update omits expected_updated_at when the flag is not supplied", async () => {
  const issues = await import("../commands/issues.mjs");
  const ctx = makeCtx({ _: ["update", "issue_1"], status: "in_progress" }, { data: { id: "issue_1" } });
  await issues.run([], ctx);
  assert.ok(!("expected_updated_at" in ctx.calls[0].body), "expected_updated_at must not appear unless the flag was given");
});

// ── 412 precondition-failed rendering (R-90) ─────────────────────────────────
//
// These exercise lib/api.mjs's api() directly against a stubbed global.fetch
// (no network) — the command-level stubbed ctx.api bypasses this entirely, so
// this is the only layer where the 412 message-building logic itself lives.

function withStubbedFetch(status, jsonBody, fn) {
  const originalFetch = globalThis.fetch;
  const originalEnvUrl = process.env.NOPM_API_URL;
  const originalEnvToken = process.env.NOPM_TOKEN;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  });
  process.env.NOPM_API_URL = "http://test";
  process.env.NOPM_TOKEN = "npm_test";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
      if (originalEnvUrl === undefined) delete process.env.NOPM_API_URL; else process.env.NOPM_API_URL = originalEnvUrl;
      if (originalEnvToken === undefined) delete process.env.NOPM_TOKEN; else process.env.NOPM_TOKEN = originalEnvToken;
    });
}

test("api() renders a friendly message on 412 and preserves the raw payload", async () => {
  await withStubbedFetch(412, { error: "Record changed since you loaded it", code: "precondition_failed", current_updated_at: "2026-09-07T08:12:44.031Z" }, async () => {
    await assert.rejects(
      () => api("PATCH", "/api/tasks/task_1", { status_type: "completed", expected_updated_at: "2026-01-01T00:00:00Z" }),
      (e) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.status, 412);
        assert.equal(
          e.message,
          "Precondition failed: the record changed since you loaded it (current updated_at: 2026-09-07T08:12:44.031Z). Re-run with --expected-updated-at 2026-09-07T08:12:44.031Z after reviewing.",
        );
        assert.deepEqual(e.payload, { error: "Record changed since you loaded it", code: "precondition_failed", current_updated_at: "2026-09-07T08:12:44.031Z" });
        return true;
      },
    );
  });
});

test("api() 412 message falls back to 'unknown' when current_updated_at is absent (lost-race branch)", async () => {
  await withStubbedFetch(412, { error: "Record changed since you loaded it", code: "precondition_failed" }, async () => {
    await assert.rejects(
      () => api("PATCH", "/api/tasks/task_1", { expected_updated_at: "2026-01-01T00:00:00Z" }),
      (e) => {
        assert.match(e.message, /current updated_at: unknown/);
        assert.match(e.message, /--expected-updated-at unknown/);
        return true;
      },
    );
  });
});

test("api() non-412 errors keep the plain HTTP <status>: <error> message", async () => {
  await withStubbedFetch(422, { error: "Invalid rag_status" }, async () => {
    await assert.rejects(
      () => api("PATCH", "/api/tasks/task_1", { rag_status: "bogus" }),
      (e) => {
        assert.equal(e.status, 422);
        assert.equal(e.message, "HTTP 422: Invalid rag_status");
        return true;
      },
    );
  });
});

// ── D-16 / D-17 / idempotency / Retry-After ─────────────────────────────────

test("api() 403 role_not_permitted renders a clean not-allowed message and keeps the payload", async () => {
  await withStubbedFetch(403, { error: "Only managers and admins can approve", code: "role_not_permitted" }, async () => {
    await assert.rejects(
      () => api("POST", "/api/deletion-requests/x/approve"),
      (e) => {
        assert.equal(e.status, 403);
        assert.match(e.message, /^Not allowed: Only managers and admins can approve./);
        assert.equal(e.payload.code, "role_not_permitted");
        return true;
      },
    );
  });
});

test("api() 429 message carries the Retry-After seconds", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "17" : null) }, json: async () => ({ error: "Rate limit exceeded", code: "rate_limited" }) });
  process.env.NOPM_API_URL = "http://test";
  process.env.NOPM_TOKEN = "npm_test";
  try {
    await assert.rejects(() => api("GET", "/api/projects"), (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 17);
      assert.match(e.message, /retry in 17s/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("idempotencyHeader: only POST with a non-empty string key sends the header", async () => {
  const { idempotencyHeader } = await import("../lib/api.mjs");
  assert.deepEqual(idempotencyHeader("POST", "abc-1"), { "Idempotency-Key": "abc-1" });
  assert.deepEqual(idempotencyHeader("POST", true), {});
  assert.deepEqual(idempotencyHeader("POST", "  "), {});
  assert.deepEqual(idempotencyHeader("GET", "abc-1"), {});
  assert.deepEqual(idempotencyHeader("POST", undefined), {});
});

test("api() sends the Idempotency-Key header on a keyed POST", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => { seen = init.headers; return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ data: {} }) }; };
  process.env.NOPM_API_URL = "http://test";
  process.env.NOPM_TOKEN = "npm_test";
  try {
    await api("POST", "/api/expenses", { amount: 1 }, { idempotencyKey: "retry-42" });
    assert.equal(seen["Idempotency-Key"], "retry-42");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("create commands document --idempotency-key in their usage", async () => {
  for (const g of ["expenses", "tasks", "allocations"]) {
    const mod = await import(`../commands/${g}.mjs`);
    assert.ok(mod.usage.join("|").includes("--idempotency-key"), `${g} usage lacks --idempotency-key`);
  }
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

// ── Pattern answers: channels can close a risk / confirm a milestone / close a sprint ──

test("risks update sends --resolution", async () => {
  const risks = await import("../commands/risks.mjs");
  const ctx = makeCtx({ _: ["update", "r1"], status: "closed", resolution: "Vendor replaced" }, { data: {} });
  await risks.run([], ctx);
  assert.deepEqual(ctx.calls[0].body, { status: "closed", resolution: "Vendor replaced" });
});

test("milestones update sends confirm_open_tasks only with --confirm-open-tasks", async () => {
  const ms = await import("../commands/milestones.mjs");
  const a = makeCtx({ _: ["update", "m1"], status: "completed", "confirm-open-tasks": true }, { data: {} });
  await ms.run([], a);
  assert.equal(a.calls[0].body.confirm_open_tasks, true);
  const b = makeCtx({ _: ["update", "m1"], status: "completed" }, { data: {} });
  await ms.run([], b);
  assert.equal("confirm_open_tasks" in b.calls[0].body, false);
});

test("sprints close sends move_unfinished_to and guards a missing id", async () => {
  const sp = await import("../commands/sprints.mjs");
  const ctx = makeCtx({ _: ["close", "s1"], "move-unfinished-to": "backlog" }, { data: {} });
  await sp.run([], ctx);
  assert.equal(ctx.calls[0].path, "/api/sprints/s1/close");
  assert.deepEqual(ctx.calls[0].body, { move_unfinished_to: "backlog" });
  await expectDies(() => sp.run([], makeCtx({ _: ["close"] })), /usage/);
});

// ── Lean list payloads (R-129) + risk taxonomy (K1/K2) ──────────────────────

test("list commands ask for view=full so --json keeps every column", async () => {
  for (const [mod, flags, path] of [
    ["projects", { _: ["ls"] }, "/api/projects?page=1&limit=100&view=full"],
    ["tasks", { _: ["ls"], project: "p1" }, "/api/projects/p1/tasks?page=1&limit=100&view=full"],
    ["risks", { _: ["ls"], project: "p1" }, "/api/projects/p1/risks?page=1&limit=100&view=full"],
    ["issues", { _: ["ls"], project: "p1" }, "/api/projects/p1/issues?page=1&limit=100&view=full"],
    ["milestones", { _: ["ls"], project: "p1" }, "/api/projects/p1/milestones?page=1&limit=100&view=full"],
  ]) {
    const m = await import(`../commands/${mod}.mjs`);
    const ctx = makeCtx(flags);
    await m.run([], ctx);
    assert.deepEqual(ctx.calls, [{ method: "GET", path, body: undefined }], mod);
  }
});

test("risks create sends risk_category and impact_areas (array), never the retired category", async () => {
  const risks = await import("../commands/risks.mjs");
  const ctx = makeCtx(
    { _: ["create"], project: "p1", title: "Vendor slips", severity: "high", likelihood: "medium", "risk-category": "supplier_external", "impact-area": "cost, schedule" },
    { data: { id: "r1", reference_id: "R-1" } },
  );
  await risks.run([], ctx);
  assert.deepEqual(ctx.calls[0].body, {
    title: "Vendor slips",
    severity: "high",
    likelihood: "medium",
    risk_category: "supplier_external",
    impact_areas: ["cost", "schedule"],
  });
  assert.ok(!("category" in ctx.calls[0].body));
});

test("risks update --impact-area sends impact_areas", async () => {
  const risks = await import("../commands/risks.mjs");
  const ctx = makeCtx({ _: ["update", "r1"], "impact-area": "quality" }, { data: { id: "r1" } });
  await risks.run([], ctx);
  assert.deepEqual(ctx.calls[0], { method: "PATCH", path: "/api/risks/r1", body: { impact_areas: ["quality"] } });
});

test("risks create/update die on the retired --category and point to --risk-category", async () => {
  const risks = await import("../commands/risks.mjs");
  for (const sub of ["create", "update"]) {
    const ctx = makeCtx({ _: [sub, "r1"], project: "p1", title: "t", severity: "low", likelihood: "low", category: "Technical" });
    await assert.rejects(() => risks.run([], ctx), /--risk-category/);
    assert.equal(ctx.calls.length, 0);
  }
});

// ── deletion is a request for every governed record (audit gap G8) ──────────

for (const [cmd, path] of [
  ["risks", "risks"],
  ["issues", "issues"],
  ["milestones", "milestones"],
  ["expenses", "expenses"],
  ["documents", "documents"],
]) {
  test(`${cmd} rm needs an id and a reason, and sends DELETE /api/${path}/<id> with the reason`, async () => {
    const mod = await import(`../commands/${cmd}.mjs`);
    const noReason = makeCtx({ _: ["rm", "rec_1"] });
    await expectDies(() => mod.run([], noReason), new RegExp(`usage: nopm ${cmd} rm <id> --reason`));
    assert.equal(noReason.calls.length, 0, "no API call may fire without a reason");

    const ctx = makeCtx({ _: ["rm", "rec_1"], reason: "duplicate" }, { data: { id: "dr_1" } });
    await mod.run([], ctx);
    assert.deepEqual(ctx.calls, [{ method: "DELETE", path: `/api/${path}/rec_1`, body: { reason: "duplicate" } }]);
  });
}
