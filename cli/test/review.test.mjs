// cli/test/review.test.mjs — contract tests for `nopm review` (node --test, no deps).
//
// Same style as cli.test.mjs: each case runs the command module's run() with a
// stubbed ctx and asserts the request it builds and what it prints. The
// dispatcher auto-discovers commands/*.mjs, so registration itself is asserted
// by listing the directory the way nopm.mjs does and checking describe/usage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { die, CliError } from "../lib/api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const ITEM = {
  kind: "change_request",
  id: "cr_1",
  title: "Change request CR-0007: Add SSO to scope",
  summary: "under_review · scope · high priority",
  project_id: "proj_1",
  project_name: "Apollo",
  requested_by_label: "Requester A",
  requested_at: "2026-10-09T08:00:00+00:00",
  can_decide: true,
  reason_if_not: null,
};

/** ctx whose api returns `envelope` and whose out/die are observable. */
function makeCtx(flags, envelope = { data: [], total: 0, page: 1, limit: 50, hidden_kinds: [] }) {
  const calls = [];
  const printed = [];
  return {
    calls,
    printed,
    flags,
    api: async (method, p, body) => {
      calls.push({ method, path: p, body });
      return envelope;
    },
    out: (data, _ctx, columns) => printed.push({ data, columns }),
    die,
    loadConfig: () => ({ url: "http://test", token: "npm_test" }),
  };
}

/** Capture console.error (notes go to stderr so --json stdout stays parseable). */
async function captureStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

test("review is discovered by the dispatcher and documents itself", async () => {
  const files = (await readdir(path.join(here, "..", "commands"))).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.includes("review.mjs"));
  const mod = await import("../commands/review.mjs");
  assert.match(mod.describe, /waiting|pending|decisions/i);
  assert.ok(Array.isArray(mod.usage) && mod.usage[0].startsWith("nopm review"));
  assert.equal(typeof mod.run, "function");
});

test("review with no flags sends GET /api/review with page=1&limit=50 and no body", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [] });
  await review.run([], ctx);
  assert.deepEqual(ctx.calls, [{ method: "GET", path: "/api/review?page=1&limit=50", body: undefined }]);
});

test("review passes --kind/--page/--limit through as query params (kind URL-encoded)", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [], kind: "rebaseline,change_request", page: "2", limit: "10" });
  await review.run([], ctx);
  assert.deepEqual(ctx.calls, [
    { method: "GET", path: "/api/review?kind=rebaseline%2Cchange_request&page=2&limit=10", body: undefined },
  ]);
});

test("review --kind with no value dies BEFORE calling the API", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [], kind: true });
  await assert.rejects(
    () => review.run([], ctx),
    (e) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, /--kind needs a value/);
      return true;
    },
  );
  assert.equal(ctx.calls.length, 0);
});

test("review is read-only: it never issues a non-GET request", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [], kind: "rebaseline" }, { data: [ITEM], total: 1, page: 1, limit: 50, hidden_kinds: [] });
  await review.run([], ctx);
  assert.ok(ctx.calls.every((c) => c.method === "GET" && c.body === undefined));
});

test("review renders a table row per item with a readable decide column", async () => {
  const review = await import("../commands/review.mjs");
  const blocked = {
    ...ITEM,
    id: "rb_1",
    kind: "rebaseline",
    title: "Rebaseline: Project One",
    project_name: null,
    can_decide: false,
    reason_if_not: "You requested this; four-eyes requires a different person to decide",
  };
  const ctx = makeCtx({ _: [] }, { data: [ITEM, blocked], total: 2, page: 1, limit: 50, hidden_kinds: [] });
  await review.run([], ctx);

  assert.equal(ctx.printed.length, 1);
  const { data, columns } = ctx.printed[0];
  assert.deepEqual(columns, ["kind", "title", "project", "requested_by", "requested_at", "id", "decide"]);
  assert.deepEqual(data[0], {
    kind: "change_request",
    title: ITEM.title,
    project: "Apollo",
    requested_by: "Requester A",
    requested_at: "2026-10-09 08:00",
    id: "cr_1",
    decide: "yes",
  });
  assert.equal(data[1].project, "");
  assert.equal(data[1].decide, "no — You requested this; four-eyes requires a different person to decide");
});

test("review --json hands the raw items (with summary and project_id) to out()", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [], json: true }, { data: [ITEM], total: 1, page: 1, limit: 50, hidden_kinds: [] });
  await review.run([], ctx);
  assert.deepEqual(ctx.printed[0].data, [ITEM]);
  assert.equal(ctx.printed[0].columns, undefined);
});

test("review warns on stderr when the token cannot read some kinds (empty != nothing pending)", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [] }, { data: [], total: 0, page: 1, limit: 50, hidden_kinds: ["task_deletion", "rebaseline"] });
  const lines = await captureStderr(() => review.run([], ctx));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /task_deletion, rebaseline/);
  assert.match(lines[0], /not proof nothing is pending/);
});

test("review tells you when the page is not the whole list", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [] }, { data: [ITEM], total: 7, page: 1, limit: 1, hidden_kinds: [] });
  const lines = await captureStderr(() => review.run([], ctx));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /showing 1 of 7/);
  assert.match(lines[0], /--page 2/);
});

test("review stays quiet when everything fits and nothing is hidden", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [] }, { data: [ITEM], total: 1, page: 1, limit: 50, hidden_kinds: [] });
  const lines = await captureStderr(() => review.run([], ctx));
  assert.deepEqual(lines, []);
});

test("review tolerates an older server that omits hidden_kinds / total", async () => {
  const review = await import("../commands/review.mjs");
  const ctx = makeCtx({ _: [] }, { data: [ITEM] });
  const lines = await captureStderr(() => review.run([], ctx));
  assert.deepEqual(lines, []);
  assert.equal(ctx.printed[0].data.length, 1);
});
