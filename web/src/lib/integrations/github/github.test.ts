import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { CONNECTOR_ID, FakeDb, TEST_ENCRYPTION_KEY, WS, connectorRow, type Row } from "@/lib/integrations/test-support";
import { handleGithubWebhook, type GithubWebhookDeps } from "./http";
import { deploymentPullNumbers, parseGithubDelivery } from "./parse";
import { formatPullRef, lookupCandidates, normalizePullRefInput, parsePullRef } from "./refs";
import { DEFAULT_RULES, normalizeRules, statusRank, targetRank, validateRulesPatch } from "./rules";
import { decryptWebhookSecret, encryptWebhookSecret } from "./secrets";
import { getGithubConnectorById, type GithubConnectorRow } from "./store";
import { signGithubBody, verifyGithubSignature } from "./verify";

const SECRET = "npg_test-secret-value-0123456789";
const PROJECT = "p0000000-0000-4000-8000-000000000001";
const LOCKED_PROJECT = "p0000000-0000-4000-8000-000000000002";
const TASK = "t0000000-0000-4000-8000-000000000001";
const LOCKED_TASK = "t0000000-0000-4000-8000-000000000002";
const T_UPDATED = "2026-10-18T08:00:00.000Z";

let db: FakeDb;

function deps(over: Partial<GithubWebhookDeps> = {}): GithubWebhookDeps {
  return {
    db: db as unknown as SupabaseClient,
    loadConnector: getGithubConnectorById,
    readSecret: (c) => decryptWebhookSecret(c.secret_enc),
    rateCheck: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log: () => {},
    ...over,
  };
}

function seed(over: { rules?: Row; connector?: Partial<Row> } = {}) {
  db.seed("integration_connectors", [
    {
      ...(connectorRow() as unknown as Row),
      kind: "github",
      name: "GitHub",
      config: {},
      secret_enc: encryptWebhookSecret(SECRET),
      ...over.connector,
    },
  ]);
  db.seed("workspaces", [{ id: WS, name: "Acme PMO", ...(over.rules ? { work_event_rules: over.rules } : {}) }]);
  db.seed("projects", [
    { id: PROJECT, workspace_id: WS, is_locked: false },
    { id: LOCKED_PROJECT, workspace_id: WS, is_locked: true },
  ]);
  db.seed("tasks", [
    {
      id: TASK,
      workspace_id: WS,
      project_id: PROJECT,
      name: "Ship it",
      status: "Backlog",
      status_type: "unstarted",
      external_ref: "github:acme/widgets#7",
      updated_at: T_UPDATED,
    },
    {
      id: LOCKED_TASK,
      workspace_id: WS,
      project_id: LOCKED_PROJECT,
      name: "Frozen",
      status: "Backlog",
      status_type: "unstarted",
      external_ref: "github:acme/widgets#9",
      updated_at: T_UPDATED,
    },
  ]);
}

function prPayload(action: string, number: number, extra: Row = {}) {
  return {
    action,
    pull_request: { number, merged: false, ...extra },
    repository: { full_name: "acme/widgets" },
    sender: { login: "octo-dev" },
  };
}

function deployPayload(state_: string, payload: unknown, ref = "main") {
  return {
    deployment: { ref, payload },
    deployment_status: { state: state_, creator: { login: "deploy-bot[bot]" } },
    repository: { full_name: "acme/widgets" },
  };
}

let delivery = 0;
function request(event: string, payload: unknown, opts: { secret?: string; signature?: string | null; id?: string | null; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json", "x-github-event": event });
  const sig = opts.signature === undefined ? signGithubBody(raw, opts.secret ?? SECRET) : opts.signature;
  if (sig) headers.set("x-hub-signature-256", sig);
  const id = opts.id === undefined ? `delivery-${++delivery}-abcdef` : opts.id;
  if (id) headers.set("x-github-delivery", id);
  return new Request("http://localhost/api/integrations/github/x/events", { method: "POST", headers, body: raw });
}

const post = (req: Request, d: GithubWebhookDeps = deps()) => handleGithubWebhook(req, CONNECTOR_ID, d);
const task = (id: string) => db.rows("tasks").find((t) => t.id === id)!;
const events = () => db.rows("work_events");
const auditActions = () => db.rows("audit_log").map((a) => a.action);

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  db = new FakeDb();
  state.db = db;
  seed();
});
afterEach(() => vi.unstubAllEnvs());

describe("signature", () => {
  it("accepts a valid signature and applies nothing for ping", async () => {
    const res = await post(request("ping", { zen: "x" }));
    expect(res.status).toBe(200);
    expect(events()).toHaveLength(0);
  });

  it("verifies in constant time over equal-length hex and rejects malformed headers", () => {
    const sig = signGithubBody("body", SECRET);
    expect(verifyGithubSignature("body", sig, SECRET)).toBe(true);
    expect(verifyGithubSignature("body ", sig, SECRET)).toBe(false);
    expect(verifyGithubSignature("body", sig, "other")).toBe(false);
    expect(verifyGithubSignature("body", null, SECRET)).toBe(false);
    expect(verifyGithubSignature("body", "sha256=short", SECRET)).toBe(false);
    expect(verifyGithubSignature("body", sig.replace("sha256=", "sha1="), SECRET)).toBe(false);
  });

  it("answers a tampered body with a generic 401 and records nothing", async () => {
    const payload = prPayload("opened", 7);
    const res = await post(request("pull_request", payload, { signature: signGithubBody(JSON.stringify(payload) + " ", SECRET) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(events()).toHaveLength(0);
    expect(task(TASK).status_type).toBe("unstarted");
  });

  it("answers a wrong secret and a missing signature the same way", async () => {
    const wrong = await post(request("pull_request", prPayload("opened", 7), { secret: "not-the-secret" }));
    const missing = await post(request("pull_request", prPayload("opened", 7), { signature: null }));
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(await wrong.json());
  });

  it("treats an unknown, paused and revoked connector as the same generic 401", async () => {
    const body = prPayload("opened", 7);
    const unknownId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect((await handleGithubWebhook(request("pull_request", body), unknownId, deps())).status).toBe(401);
    for (const status of ["paused", "revoked"]) {
      db = new FakeDb();
      state.db = db;
      seed({ connector: { status } });
      const res = await post(request("pull_request", body));
      expect(res.status).toBe(401);
      expect(events()).toHaveLength(0);
    }
  });

  it("rejects a malformed connector id with 404 and a lark connector id with 401", async () => {
    expect((await handleGithubWebhook(request("ping", {}), "not-a-uuid", deps())).status).toBe(404);
    db = new FakeDb();
    state.db = db;
    seed({ connector: { kind: "lark" } });
    expect((await post(request("pull_request", prPayload("opened", 7)))).status).toBe(401);
  });

  it("refuses a body over the cap with 413 before any lookup", async () => {
    const res = await post(request("pull_request", {}, { raw: "x".repeat(1024 * 1024 + 10), signature: "sha256=" + "0".repeat(64) }));
    expect(res.status).toBe(413);
  });

  it("answers 429 once the failed-attempt bucket is spent", async () => {
    const res = await post(request("pull_request", prPayload("opened", 7), { signature: null }), deps({ rateCheck: async () => ({ allowed: false, retryAfterSeconds: 12 }) }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });
});

describe("status mapping", () => {
  it("moves a linked task to started when the pull request opens, with one connector-attributed audit row", async () => {
    const res = await post(request("pull_request", prPayload("opened", 7), { id: "delivery-open-0001" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(task(TASK).status_type).toBe("started");
    expect(events()[0]).toMatchObject({ kind: "pr_opened", ref: "acme/widgets#7", applied: true, reason: "applied", task_id: TASK, actor_login: "octo-dev" });
    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "task.update",
      target_id: TASK,
      channel: "github",
      via_connector_id: CONNECTOR_ID,
      external_event_id: "delivery-open-0001",
      external_actor_ref: "github:octo-dev",
      actor_type: "token",
    });
  });

  it("moves to in review on merge and completed on a successful deployment naming the pull request", async () => {
    await post(request("pull_request", prPayload("closed", 7, { merged: true })));
    expect(task(TASK)).toMatchObject({ status_type: "started", status: "In review" });

    await post(request("deployment_status", deployPayload("success", { pr: 7 })));
    expect(task(TASK)).toMatchObject({ status_type: "completed", status: "Done" });
    expect(events().map((e) => e.kind)).toEqual(["pr_merged", "deploy_success"]);
    expect(auditActions()).toEqual(["task.update", "task.update"]);
  });

  it("reads the pull request from a pull ref when the deployment payload names none", async () => {
    await post(request("deployment_status", deployPayload("success", null, "refs/pull/7/merge")));
    expect(task(TASK).status_type).toBe("completed");
  });

  it("does nothing for a deploy failure by default but still records it", async () => {
    await post(request("deployment_status", deployPayload("failure", { pr: 7 })));
    expect(task(TASK).status_type).toBe("unstarted");
    expect(events()[0]).toMatchObject({ kind: "deploy_failure", applied: false, reason: "no_rule", task_id: TASK });
    expect(auditActions()).toEqual([]);
  });

  it("follows a changed workspace mapping", async () => {
    db = new FakeDb();
    state.db = db;
    seed({ rules: { ...DEFAULT_RULES, pr_opened: "completed", pr_closed: "canceled" } });
    await post(request("pull_request", prPayload("opened", 7)));
    expect(task(TASK).status_type).toBe("completed");
  });

  it("cancels a task when the mapping says a closed, unmerged pull request cancels", async () => {
    db = new FakeDb();
    state.db = db;
    seed({ rules: { ...DEFAULT_RULES, pr_closed: "canceled" } });
    await post(request("pull_request", prPayload("closed", 7)));
    expect(task(TASK).status_type).toBe("canceled");
  });

  it("records an unknown reference as not applied, without an audit row", async () => {
    const res = await post(request("pull_request", prPayload("opened", 404)));
    expect(res.status).toBe(200);
    expect(events()[0]).toMatchObject({ ref: "acme/widgets#404", applied: false, reason: "unknown_ref", task_id: null });
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("never moves a task backwards or out of completed or canceled", async () => {
    task(TASK).status_type = "completed";
    await post(request("pull_request", prPayload("opened", 7, { title: "first" })));
    expect(task(TASK).status_type).toBe("completed");
    expect(events()[0]).toMatchObject({ applied: false, reason: "already_at_or_beyond" });

    task(TASK).status_type = "canceled";
    await post(request("pull_request", prPayload("opened", 7, { title: "second" })));
    expect(task(TASK).status_type).toBe("canceled");
    expect(events()[1]).toMatchObject({ applied: false, reason: "task_canceled" });
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("skips a task on a locked project with one work_event.skipped audit row and no status change", async () => {
    const res = await post(request("pull_request", prPayload("opened", 9), { id: "delivery-locked-001" }));
    expect(res.status).toBe(200);
    expect(task(LOCKED_TASK).status_type).toBe("unstarted");
    expect(events()[0]).toMatchObject({ applied: false, reason: "project_locked", task_id: LOCKED_TASK });
    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "work_event.skipped", target_id: LOCKED_TASK, channel: "github", via_connector_id: CONNECTOR_ID });
  });

  it("matches a lower-case stored reference to a mixed-case repository name, and the exact spelling", async () => {
    const mixed = { ...prPayload("opened", 7), repository: { full_name: "Acme/Widgets" } };
    await post(request("pull_request", mixed));
    expect(task(TASK).status_type).toBe("started");

    task(TASK).status_type = "unstarted";
    task(TASK).updated_at = "2026-10-18T09:30:00.000Z";
    task(TASK).external_ref = "github:Acme/Widgets#7";
    await post(request("pull_request", { ...mixed, note: "again" }));
    expect(task(TASK).status_type).toBe("started");
  });

  it("does not touch a task whose version changed since it was read (optimistic concurrency)", async () => {
    const original = db.rpc.bind(db);
    // The row is changed by someone else between the read and the write.
    db.rpc = (async (name?: string, args?: Record<string, unknown>) => {
      task(TASK).updated_at = "2026-10-18T09:00:00.000Z";
      return original(name, args);
    }) as typeof db.rpc;
    await post(request("pull_request", prPayload("opened", 7)));
    expect(task(TASK).status_type).toBe("unstarted");
    expect(events()[0]).toMatchObject({ applied: false, reason: "conflict" });
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("only ever touches tasks of the connector's own workspace", async () => {
    db.seed("tasks", [
      { id: "t0000000-0000-4000-8000-000000000099", workspace_id: "22222222-2222-4222-8222-222222222222", project_id: PROJECT, status_type: "unstarted", status: "Backlog", external_ref: "github:acme/widgets#55", updated_at: T_UPDATED },
    ]);
    await post(request("pull_request", prPayload("opened", 55)));
    expect(db.rows("tasks").find((t) => t.id === "t0000000-0000-4000-8000-000000000099")!.status_type).toBe("unstarted");
    expect(events()[0].reason).toBe("unknown_ref");
  });
});

describe("replay and limits", () => {
  it("answers a redelivered X-GitHub-Delivery with 200 and changes nothing a second time", async () => {
    const payload = prPayload("opened", 7);
    await post(request("pull_request", payload, { id: "delivery-replay-001" }));
    task(TASK).status_type = "unstarted"; // someone moved it back; a replay must not redo the move
    task(TASK).updated_at = "2026-10-18T10:00:00.000Z";
    const again = await post(request("pull_request", payload, { id: "delivery-replay-001" }));
    expect(again.status).toBe(200);
    expect(task(TASK).status_type).toBe("unstarted");
    expect(events()).toHaveLength(1);
    expect(db.rows("audit_log")).toHaveLength(1);
  });

  it("handles at most five pull requests named by one deployment", async () => {
    const tasks: Row[] = [];
    for (let n = 101; n <= 107; n++) {
      tasks.push({ id: `t0000000-0000-4000-8000-0000000001${n}`, workspace_id: WS, project_id: PROJECT, status_type: "started", status: "In progress", external_ref: `github:acme/widgets#${n}`, updated_at: T_UPDATED });
    }
    db.seed("tasks", tasks);
    await post(request("deployment_status", deployPayload("success", { prs: [101, 102, 103, 104, 105, 106, 107] })));
    expect(events()).toHaveLength(7);
    expect(db.rows("tasks").filter((t) => t.status_type === "completed")).toHaveLength(5);
    // The two beyond the cap are recorded for the trail, never acted on.
    const extra = events().filter((e) => e.reason === "truncated");
    expect(extra.map((e) => e.ref)).toEqual(["acme/widgets#106", "acme/widgets#107"]);
    expect(extra.every((e) => e.applied === false)).toBe(true);
    expect(db.rows("tasks").find((t) => t.external_ref === "github:acme/widgets#107")!.status_type).toBe("started");
  });

  it("answers 200 and records nothing for events it does not act on", async () => {
    expect((await post(request("push", { ref: "refs/heads/main" }))).status).toBe(200);
    expect((await post(request("pull_request", prPayload("labeled", 7)))).status).toBe(200);
    expect((await post(request("deployment_status", deployPayload("pending", { pr: 7 })))).status).toBe(200);
    expect(events()).toHaveLength(0);
  });

  it("rejects a signed delivery with no delivery id or unreadable JSON, and answers 503 when nothing could be recorded", async () => {
    expect((await post(request("pull_request", prPayload("opened", 7), { id: null }))).status).toBe(400);
    const raw = "{not json";
    expect((await post(request("pull_request", null, { raw }))).status).toBe(400);
    db.failNext({ table: "work_events", op: "insert", error: { message: "boom" } });
    const res = await post(request("pull_request", prPayload("opened", 7)));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });

  it("keeps answering 200 when applying a recorded event fails", async () => {
    // The move and its audit row are one database call: when it fails, nothing changed.
    db.rpc = (async () => ({ data: null, error: { message: "audit down" }, count: null })) as unknown as typeof db.rpc;
    const res = await post(request("pull_request", prPayload("opened", 7)));
    expect(res.status).toBe(200);
    expect(events()[0]).toMatchObject({ applied: false, reason: "error" });
    expect(task(TASK).status_type).toBe("unstarted");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("refuses the same signed body resent under a fresh delivery id for 24 hours (recorded as a replay)", async () => {
    const payload = prPayload("opened", 7);
    await post(request("pull_request", payload, { id: "delivery-original-01" }));
    expect(task(TASK).status_type).toBe("started");
    task(TASK).status_type = "unstarted";
    task(TASK).updated_at = "2026-10-18T10:00:00.000Z";
    const again = await post(request("pull_request", payload, { id: "delivery-fresh-id-02" }));
    expect(again.status).toBe(200);
    expect(task(TASK).status_type).toBe("unstarted");
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ external_event_id: "delivery-fresh-id-02", applied: false, reason: "replay" });
    expect(db.rows("audit_log")).toHaveLength(1);
  });

  it("lets the same body through again once the 24 hour window has passed", async () => {
    const payload = prPayload("opened", 7);
    await post(request("pull_request", payload, { id: "delivery-original-03" }));
    events()[0].received_at = new Date(Date.now() - 25 * 3600_000).toISOString();
    task(TASK).status_type = "unstarted";
    task(TASK).updated_at = "2026-10-18T10:00:00.000Z";
    await post(request("pull_request", payload, { id: "delivery-later-004" }));
    expect(task(TASK).status_type).toBe("started");
  });
});

describe("pure helpers", () => {
  it("parses pull request and deployment payloads and ignores the rest", () => {
    expect(parseGithubDelivery("pull_request", prPayload("closed", 3, { merged: true }))).toEqual([
      { kind: "pr_merged", repo: "acme/widgets", number: 3, login: "octo-dev" },
    ]);
    expect(parseGithubDelivery("pull_request", prPayload("closed", 3))[0].kind).toBe("pr_closed");
    expect(parseGithubDelivery("pull_request", prPayload("reopened", 3))[0].kind).toBe("pr_opened");
    expect(parseGithubDelivery("pull_request", prPayload("synchronize", 3))).toEqual([]);
    expect(parseGithubDelivery("deployment_status", deployPayload("error", {}))).toEqual([
      { kind: "deploy_failure", repo: "acme/widgets", number: null, login: "deploy-bot[bot]" },
    ]);
    expect(parseGithubDelivery("push", {})).toEqual([]);
    expect(parseGithubDelivery("pull_request", { action: "opened", pull_request: { number: "7" }, repository: { full_name: "acme/widgets" } })).toEqual([]);
    expect(parseGithubDelivery("pull_request", { ...prPayload("opened", 7), repository: { full_name: "bad repo name" } })).toEqual([]);
    expect(parseGithubDelivery("pull_request", { ...prPayload("opened", 7), sender: { login: "x y;drop" } })[0].login).toBeNull();
  });

  it("collects pull request numbers from payload shapes and refs", () => {
    expect(deploymentPullNumbers({ payload: JSON.stringify({ pr_number: "12" }), ref: "main" })).toEqual([12]);
    expect(deploymentPullNumbers({ payload: { pull_request: { number: 4 } }, ref: "pr-9" })).toEqual([4, 9]);
    expect(deploymentPullNumbers({ payload: { prs: [{ number: 1 }, 2, "x", -3] }, ref: "main" })).toEqual([1, 2]);
    expect(deploymentPullNumbers({ ref: "feature/pr-without-number" })).toEqual([]);
  });

  it("formats, parses and normalises pull request references", () => {
    expect(formatPullRef({ owner: "acme", repo: "widgets", number: 7 })).toBe("github:acme/widgets#7");
    expect(parsePullRef("github:acme/widgets#7")).toEqual({ owner: "acme", repo: "widgets", number: 7 });
    expect(parsePullRef("acme/widgets#7")).toBeNull();
    expect(normalizePullRefInput("Acme/Widgets#7")).toBe("github:acme/widgets#7");
    expect(normalizePullRefInput("https://github.com/Acme/widgets/pull/7/files")).toBe("github:acme/widgets#7");
    expect(normalizePullRefInput("github:acme/widgets#0")).toBeNull();
    expect(normalizePullRefInput("not a ref")).toBeNull();
    expect(lookupCandidates({ owner: "Acme", repo: "w", number: 1 })).toEqual(["github:Acme/w#1", "github:acme/w#1"]);
  });

  it("validates rules and orders statuses forward", () => {
    expect(normalizeRules({ pr_opened: "bogus", deploy_failure: "canceled" })).toMatchObject({ pr_opened: "started", deploy_failure: "canceled" });
    expect(validateRulesPatch({ pr_opened: "completed", deploy_failure: null })).toEqual({ ok: true, rules: { pr_opened: "completed", deploy_failure: null } });
    expect(validateRulesPatch({ pr_opened: "done" }).ok).toBe(false);
    expect(validateRulesPatch({ nonsense: "started" }).ok).toBe(false);
    expect(validateRulesPatch({}).ok).toBe(false);
    expect(statusRank("started", "In review")).toBeGreaterThan(statusRank("started", null));
    expect(targetRank("completed")).toBeGreaterThan(targetRank("in_review"));
    expect(statusRank("canceled", null)).toBe(-1);
  });

  it("round-trips the webhook secret through encryption and never exposes it in the stored blob", () => {
    const enc = encryptWebhookSecret(SECRET);
    expect(enc).not.toContain(SECRET);
    expect(decryptWebhookSecret(enc)).toBe(SECRET);
    expect(() => decryptWebhookSecret(encryptWebhookSecret(""))).toThrow();
  });

  it("types a github connector row", () => {
    const row: GithubConnectorRow["kind"] = "github";
    expect(row).toBe("github");
  });
});

describe("status labels (tasks.status is NOT NULL)", () => {
  it("sets the label that matches each new status, through open, merge and a successful deployment", async () => {
    await post(request("pull_request", prPayload("opened", 7)));
    expect(task(TASK)).toMatchObject({ status_type: "started", status: "In progress" });
    await post(request("pull_request", prPayload("closed", 7, { merged: true })));
    expect(task(TASK)).toMatchObject({ status_type: "started", status: "In review" });
    // The case that wrote NULL into tasks.status: completed has no review label, and the task read "In review".
    await post(request("deployment_status", deployPayload("success", { pr: 7 })));
    expect(task(TASK)).toMatchObject({ status_type: "completed", status: "Done" });
    expect(events().map((e) => e.reason)).toEqual(["applied", "applied", "applied"]);
    expect(db.rows("tasks").every((t) => t.status !== null && t.status !== undefined)).toBe(true);
  });

  it("keeps a label a person typed", async () => {
    task(TASK).status = "Waiting on vendor";
    await post(request("pull_request", prPayload("opened", 7)));
    expect(task(TASK)).toMatchObject({ status_type: "started", status: "Waiting on vendor" });
  });

  it("never sends a null label to the database", async () => {
    const calls: Row[] = [];
    const original = db.rpc.bind(db);
    db.rpc = (async (name?: string, args?: Record<string, unknown>) => {
      calls.push({ name, ...args });
      return original(name, args);
    }) as typeof db.rpc;
    task(TASK).status = "In review";
    task(TASK).status_type = "started";
    await post(request("deployment_status", deployPayload("success", { pr: 7 })));
    const move = calls.find((c) => c.name === "nopm_apply_task_status_from_event")!;
    expect(move.p_set_label).toBe(true);
    expect(move.p_status_label).toBe("Done");
  });

  it("the fake of the 0105 function mirrors the SQL: a null label keeps the current one", async () => {
    const res = await db.rpc("nopm_apply_task_status_from_event", {
      p_workspace_id: WS,
      p_task_id: TASK,
      p_expected_updated_at: T_UPDATED,
      p_status_type: "completed",
      p_set_label: true,
      p_status_label: null,
      p_audit: {},
      p_skip_audit: {},
    });
    expect((res.data as { result: string }).result).toBe("applied");
    expect(task(TASK).status).toBe("Backlog");
  });
});
