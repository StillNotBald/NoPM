import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ScopeError } from "@/lib/api/errors";
import {
  DECIDE_SCOPES,
  MAX_LIMIT,
  PENDING_KINDS,
  READ_SCOPES,
  clip,
  evaluateDecision,
  listPendingApprovals,
  resolveActorPrincipal,
  type ScopeProbe,
} from "./pending";

// ── fakes ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Result = { data?: Row[]; count?: number; error?: { message: string } };
type Call = { table: string; ops: Array<[string, unknown[]]> };

/** Chainable, awaitable fake: records every filter, resolves per table. */
function fakeDb(results: Record<string, Result>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "or", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const r = results[table] ?? {};
        const out = r.error
          ? { data: null, count: null, error: r.error }
          : { data: r.data ?? [], count: r.count ?? (r.data ?? []).length, error: null };
        return Promise.resolve(out).then(res, rej);
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

/** A scope probe that allows exactly `allowed` and explains the rest. */
const probe =
  (allowed: string[]): ScopeProbe =>
  (scope) =>
    allowed.includes(scope) ? null : `API token is missing required scope: ${scope}`;

const ALL_READ = [
  "task:read",
  "change:read",
  "project:read",
  "risk:read",
  "issue:read",
  "budget:read",
  "document:read",
  "milestone:read",
  "program:read",
  "sprint:read",
  "resource:read",
  "clash:read",
];
const ALL_DECIDE = Object.values(DECIDE_SCOPES);

const WS = "ws-1";
const ME = "user-me";
const OTHER = "user-other";

const me = { type: "user" as const, id: ME, workspaceId: WS, principalId: ME };

// Fixture rows -----------------------------------------------------------------

const deletionTask: Row = {
  id: "del-task",
  workspace_id: WS,
  target_type: "task",
  target_id: "task-1",
  reason: "duplicate of another task",
  status: "pending",
  requested_by_type: "user",
  requested_by_id: OTHER,
  requested_by_label: "Requester A",
  before: { id: "task-1", name: "Migrate billing DB", project_id: "proj-1" },
  created_at: "2026-10-10T08:00:00+00:00",
};
const deletionProject: Row = {
  id: "del-proj",
  workspace_id: WS,
  target_type: "project",
  target_id: "proj-2",
  reason: "cancelled",
  status: "pending",
  requested_by_type: "token",
  requested_by_id: "tok-1",
  requested_by_label: "agent-a (token)",
  before: { id: "proj-2", name: "Legacy portal" },
  created_at: "2026-10-11T08:00:00+00:00",
};
const change: Row = {
  id: "cr-1",
  workspace_id: WS,
  project_id: "proj-1",
  reference_id: "CR-0007",
  title: "Add SSO to scope",
  status: "under_review",
  category: "scope",
  priority: "high",
  requested_by: OTHER,
  requested_by_type: "user",
  requested_by_id: OTHER,
  requested_by_label: "Requester A",
  raised_at: "2026-10-09T08:00:00+00:00",
  created_at: "2026-10-09T08:00:00+00:00",
};
const rebaseline: Row = {
  id: "rb-1",
  workspace_id: WS,
  project_id: "proj-1",
  version: 3,
  status: "pending_approval",
  reason: "Vendor slipped delivery by two weeks",
  requested_by: "user-rb",
  created_at: "2026-10-13T08:00:00+00:00",
};

function fullDb(over: Record<string, Result> = {}) {
  return fakeDb({
    deletion_requests: { data: [deletionTask, deletionProject] },
    change_requests: { data: [change] },
    rebaselines: { data: [rebaseline] },
    projects: { data: [{ id: "proj-1", name: "Apollo" }, { id: "proj-2", name: "Legacy portal (live)" }] },
    api_tokens: { data: [{ id: "tok-1", created_by: OTHER }] },
    profiles: { data: [{ id: "user-rb", display_name: "Requester B", email: "rb@example.test" }] },
    ...over,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("listPendingApprovals — shape and ordering", () => {
  it("merges all families oldest-first with titles, summaries and names", async () => {
    const { db } = fullDb();
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));

    expect(r.items.map((i) => [i.kind, i.id])).toEqual([
      ["change_request", "cr-1"],
      ["task_deletion", "del-task"],
      ["project_deletion", "del-proj"],
      ["rebaseline", "rb-1"],
    ]);
    expect(r.total).toBe(4);
    expect(r.hidden_kinds).toEqual([]);

    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["del-task"]).toMatchObject({
      title: "Delete task: Migrate billing DB",
      summary: "duplicate of another task",
      project_id: "proj-1",
      project_name: "Apollo",
      requested_by_label: "Requester A",
      requested_at: "2026-10-10T08:00:00+00:00",
    });
    expect(byId["del-proj"]).toMatchObject({
      title: "Delete project: Legacy portal",
      project_id: "proj-2",
      project_name: "Legacy portal (live)",
    });
    expect(byId["cr-1"]).toMatchObject({
      title: "Change request CR-0007: Add SSO to scope",
      summary: "under_review · scope · high priority",
      project_name: "Apollo",
    });
    expect(byId["rb-1"]).toMatchObject({
      title: "Rebaseline v3 sign-off",
      summary: "Vendor slipped delivery by two weeks",
      requested_by_label: "Requester B",
      project_name: "Apollo",
    });
  });

  it("filters EVERY query by workspace_id (admin client bypasses RLS)", async () => {
    const { db, calls } = fullDb();
    await listPendingApprovals(db, me, probe(ALL_READ));
    const tables = calls.map((c) => c.table).sort();
    expect(tables).toEqual(
      ["api_tokens", "change_requests", "deletion_requests", "profiles", "projects", "rebaselines"].sort(),
    );
    for (const c of calls) expect(c.ops).toContainEqual(["eq", ["workspace_id", WS]]);
  });

  it("queries only the pending statuses of each family", async () => {
    const { db, calls } = fullDb();
    await listPendingApprovals(db, me, probe(ALL_READ));
    const ops = (t: string) => calls.find((c) => c.table === t)!.ops;
    expect(ops("deletion_requests")).toContainEqual(["eq", ["status", "pending"]]);
    expect(ops("deletion_requests")).toContainEqual([
      "in",
      [
        "target_type",
        ["task", "project", "risk", "issue", "expense", "document", "milestone", "program", "sprint", "resource", "allocation", "clash"],
      ],
    ]);
    expect(ops("change_requests")).toContainEqual(["in", ["status", ["raised", "under_review"]]]);
    expect(ops("rebaselines")).toContainEqual(["eq", ["status", "pending_approval"]]);
  });

  it("drops deletion rows of an unsupported target type instead of mis-labelling them", async () => {
    const { db } = fullDb({
      deletion_requests: { data: [{ ...deletionTask, id: "odd", target_type: "widget" }] },
      change_requests: { data: [] },
      rebaselines: { data: [] },
    });
    const r = await listPendingApprovals(db, me, probe(ALL_READ));
    expect(r.items).toEqual([]);
  });

  it("falls back to the legacy requested_by column for pre-0043 change requests", async () => {
    const legacy = { ...change, requested_by_type: null, requested_by_id: null, requested_by: ME };
    const { db } = fullDb({
      deletion_requests: { data: [] },
      change_requests: { data: [legacy] },
      rebaselines: { data: [] },
    });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items[0].can_decide).toBe(false);
    expect(r.items[0].reason_if_not).toMatch(/You requested this/);
  });
});

describe("listPendingApprovals — can_decide (scope + four-eyes by person)", () => {
  it("is true for another person's request when the caller holds the decide scope", async () => {
    const { db } = fullDb();
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items.every((i) => i.can_decide && i.reason_if_not === null)).toBe(true);
  });

  it("is false with the scope reason when the decide scope is missing", async () => {
    const { db } = fullDb();
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, "change:decide"]));
    const by = Object.fromEntries(r.items.map((i) => [i.kind, i]));
    expect(by.change_request.can_decide).toBe(true);
    expect(by.task_deletion.reason_if_not).toMatch(/task:delete:approve/);
    expect(by.project_deletion.reason_if_not).toMatch(/project:delete:approve/);
    expect(by.rebaseline.reason_if_not).toMatch(/rebaseline:approve/);
  });

  it("is false for the caller's own request (same actor)", async () => {
    const own = { ...deletionTask, requested_by_id: ME };
    const { db } = fullDb({ deletion_requests: { data: [own] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]), { kinds: ["task_deletion"] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ can_decide: false });
    expect(r.items[0].reason_if_not).toMatch(/You requested this/);
  });

  it("is false when a token the SAME person created raised it (principal, not actor id)", async () => {
    // tok-1 raised the project deletion; its owner is the caller's person.
    const { db } = fullDb({ api_tokens: { data: [{ id: "tok-1", created_by: ME }] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const item = r.items.find((i) => i.id === "del-proj")!;
    expect(item.can_decide).toBe(false);
    expect(item.reason_if_not).toMatch(/Raised by you/);
    // ...while a different person's items stay decidable.
    expect(r.items.find((i) => i.id === "cr-1")!.can_decide).toBe(true);
  });

  it("treats a token's request as decidable by another person (owner differs)", async () => {
    const { db } = fullDb({ api_tokens: { data: [{ id: "tok-1", created_by: OTHER }] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items.find((i) => i.id === "del-proj")!.can_decide).toBe(true);
  });

  it("prefers a stored requester principal and skips the token-owner lookup", async () => {
    const stored = { ...deletionProject, requested_principal_id: ME };
    const { db, calls } = fullDb({ deletion_requests: { data: [stored] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]), { kinds: ["project_deletion"] });
    expect(r.items[0].can_decide).toBe(false);
    expect(calls.some((c) => c.table === "api_tokens")).toBe(false);
  });

  it("a token with no recorded owner can never decide (fail-closed)", async () => {
    const token = { type: "token" as const, id: "tok-me", workspaceId: WS, principalId: null };
    const { db } = fullDb();
    const r = await listPendingApprovals(db, token, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items.length).toBeGreaterThan(0);
    for (const i of r.items) {
      expect(i.can_decide).toBe(false);
      expect(i.reason_if_not).toBe("This token has no recorded owner, so it cannot approve (four-eyes)");
    }
  });

  it("an owned token decides as its owner (principal from the actor)", async () => {
    const token = { type: "token" as const, id: "tok-me", workspaceId: WS, principalId: ME };
    const { db } = fullDb();
    const r = await listPendingApprovals(db, token, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items.every((i) => i.can_decide)).toBe(true);
  });

  it("reports a missing scope ahead of the identity reasons", async () => {
    const token = { type: "token" as const, id: "tok-me", workspaceId: WS, principalId: null };
    const { db } = fullDb();
    const r = await listPendingApprovals(db, token, probe(ALL_READ));
    expect(r.items[0].reason_if_not).toMatch(/missing required scope/);
  });
});

describe("listPendingApprovals — read gating by kind", () => {
  it("shows only the kinds the token can read and names the rest in hidden_kinds", async () => {
    const { db, calls } = fullDb();
    const r = await listPendingApprovals(db, { ...me, type: "token" }, probe(["change:read"]));
    expect(r.items.map((i) => i.kind)).toEqual(["change_request"]);
    expect(r.hidden_kinds).toEqual([
      "task_deletion",
      "project_deletion",
      "risk_deletion",
      "issue_deletion",
      "expense_deletion",
      "document_deletion",
      "milestone_deletion",
      "program_deletion",
      "sprint_deletion",
      "resource_deletion",
      "allocation_deletion",
      "clash_deletion",
      "rebaseline",
    ]);
    // Hidden families are never even queried.
    const tables = calls.map((c) => c.table);
    for (const t of ["deletion_requests", "rebaselines"]) {
      expect(tables).not.toContain(t);
    }
  });

  it("accepts audit:read as an alternative read scope for deletions (like GET /api/deletion-requests)", async () => {
    const { db } = fullDb();
    const r = await listPendingApprovals(db, { ...me, type: "token" }, probe(["audit:read"]));
    expect(r.items.map((i) => i.kind).sort()).toEqual(["project_deletion", "task_deletion"]);
    expect(r.hidden_kinds).toEqual(["change_request", "rebaseline"]);
  });

  it("403s a token that can read none of the families", async () => {
    const { db } = fullDb();
    await expect(listPendingApprovals(db, { ...me, type: "token" }, probe(["decision:read"]))).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("403s when the requested kinds are all unreadable (never an empty page that looks like 'nothing waiting')", async () => {
    const { db } = fullDb();
    await expect(
      listPendingApprovals(db, { ...me, type: "token" }, probe(["change:read"]), { kinds: ["task_deletion"] }),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("honours a kinds filter among the readable kinds", async () => {
    const { db, calls } = fullDb();
    const r = await listPendingApprovals(db, me, probe(ALL_READ), { kinds: ["change_request", "rebaseline"] });
    expect(r.items.map((i) => i.kind).sort()).toEqual(["change_request", "rebaseline"]);
    expect(calls.map((c) => c.table)).not.toContain("deletion_requests");
    expect(r.hidden_kinds).toEqual([]);
  });

  it("every kind has a read scope set and a decide scope", () => {
    for (const k of PENDING_KINDS) {
      expect(READ_SCOPES[k].length).toBeGreaterThan(0);
      expect(DECIDE_SCOPES[k]).toMatch(/:/);
    }
  });
});

describe("listPendingApprovals — paging and failure", () => {
  const many = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      ...rebaseline,
      id: `rb-${String(i).padStart(3, "0")}`,
      created_at: `2026-10-01T00:${String(i).padStart(2, "0")}:00+00:00`,
    }));

  it("slices the merged window by page/limit and reports the exact total", async () => {
    const { db } = fullDb({
      deletion_requests: { data: [] },
      change_requests: { data: [] },
      rebaselines: { data: many(7), count: 42 },
    });
    const p2 = await listPendingApprovals(db, me, probe(ALL_READ), { page: 2, limit: 3 });
    expect(p2.items.map((i) => i.id)).toEqual(["rb-003", "rb-004", "rb-005"]);
    expect(p2).toMatchObject({ page: 2, limit: 3, total: 42 });
  });

  it("asks the database for just enough rows to fill the requested page", async () => {
    const { db, calls } = fullDb();
    await listPendingApprovals(db, me, probe(ALL_READ), { page: 3, limit: 20 });
    const ts = calls.find((c) => c.table === "rebaselines")!;
    expect(ts.ops).toContainEqual(["limit", [60]]);
    expect(ts.ops).toContainEqual(["order", ["created_at", { ascending: true }]]);
  });

  it("clamps limit to the cap and defaults sensibly on junk input", async () => {
    const { db } = fullDb();
    expect((await listPendingApprovals(db, me, probe(ALL_READ), { limit: 9999 })).limit).toBe(MAX_LIMIT);
    expect((await listPendingApprovals(db, me, probe(ALL_READ), { limit: 0, page: -4 }))).toMatchObject({
      limit: 1,
      page: 1,
    });
  });

  it("throws when a source query fails — a failed check must not read as 'nothing waiting'", async () => {
    const { db } = fullDb({ change_requests: { error: { message: "relation missing" } } });
    await expect(listPendingApprovals(db, me, probe(ALL_READ))).rejects.toThrow(/change_requests query failed/);
  });

  it("throws when the token-owner lookup fails (it decides can_decide)", async () => {
    const { db } = fullDb({ api_tokens: { error: { message: "boom" } } });
    await expect(listPendingApprovals(db, me, probe(ALL_READ))).rejects.toThrow(/api_tokens lookup failed/);
  });

  it("degrades to null names when a cosmetic lookup fails", async () => {
    const { db } = fullDb({
      projects: { error: { message: "boom" } },
      profiles: { error: { message: "boom" } },
    });
    const r = await listPendingApprovals(db, me, probe(ALL_READ));
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(by["cr-1"].project_name).toBeNull();
    expect(by["rb-1"].requested_by_label).toBeNull();
    // A project-deletion still names its project from the request snapshot.
    expect(by["del-proj"].project_name).toBe("Legacy portal");
  });

  it("returns an empty page, not an error, when nothing is pending", async () => {
    const { db } = fakeDb({});
    const r = await listPendingApprovals(db, me, probe(ALL_READ));
    expect(r).toEqual({ items: [], total: 0, page: 1, limit: 50, hidden_kinds: [] });
  });
});

describe("pure helpers", () => {
  it("resolveActorPrincipal: explicit wins, else user=self / token=null", () => {
    expect(resolveActorPrincipal({ type: "token", id: "t", principalId: "p" })).toBe("p");
    expect(resolveActorPrincipal({ type: "token", id: "t", principalId: null })).toBeNull();
    expect(resolveActorPrincipal({ type: "user", id: "u" })).toBe("u");
    expect(resolveActorPrincipal({ type: "token", id: "t" })).toBeNull();
  });

  it("clip: flattens whitespace, caps length, ignores non-strings", () => {
    expect(clip("  a \n  b ")).toBe("a b");
    expect(clip("x".repeat(500), 10)).toBe("xxxxxxxxx…");
    expect(clip("   ")).toBeNull();
    expect(clip(undefined)).toBeNull();
    expect(clip(42)).toBeNull();
  });

  it("evaluateDecision: scope, then identity, then four-eyes", () => {
    const actor = { type: "user" as const, id: "u1" };
    const other = { type: "user" as const, id: "u2", principal: "u2" };
    expect(evaluateDecision({ actor, actorPrincipal: "u1", requester: other, scopeProblem: "nope" }).reason_if_not).toBe(
      "nope",
    );
    expect(evaluateDecision({ actor, actorPrincipal: null, requester: other, scopeProblem: null }).can_decide).toBe(
      false,
    );
    expect(
      evaluateDecision({ actor, actorPrincipal: "u1", requester: { type: "user", id: "u1", principal: "u1" }, scopeProblem: null })
        .reason_if_not,
    ).toMatch(/You requested this/);
    // unknown requester (no id, no principal) is not blocked by us; the decision route still enforces
    expect(
      evaluateDecision({ actor, actorPrincipal: "u1", requester: { type: null, id: null, principal: null }, scopeProblem: null })
        .can_decide,
    ).toBe(true);
  });
});

// ── G8: deletion requests for risks, issues, expenses, documents and milestones ──────────────

const deletionRow = (id: string, targetType: string, before: Row, extra: Row = {}): Row => ({
  id,
  workspace_id: WS,
  target_type: targetType,
  target_id: `${targetType}-1`,
  reason: `remove the ${targetType}`,
  status: "pending",
  requested_by_type: "user",
  requested_by_id: OTHER,
  requested_by_label: "Requester A",
  before,
  created_at: "2026-10-12T08:00:00+00:00",
  ...extra,
});

describe("listPendingApprovals — deletion of risks, issues, expenses, documents, milestones (G8)", () => {
  const rows = [
    deletionRow("del-risk", "risk", { title: "Vendor slips", project_id: "proj-1" }),
    deletionRow("del-issue", "issue", { title: "Login fails", project_id: "proj-1" }),
    deletionRow("del-expense", "expense", { description: "Hotel", project_id: "proj-1" }),
    deletionRow("del-doc", "document", { title: "Charter", project_id: "proj-1" }),
    deletionRow(
      "del-ms",
      "milestone",
      { name: "Go-live", project_id: "proj-1", child_counts: { tasks: 4 } },
      { tier: "high_risk", approval_deadline_at: "2026-10-14T08:00:00+00:00" },
    ),
  ];

  it("lists each as its own kind with its type, record name, project and the checker scope", async () => {
    const { db } = fullDb({ deletion_requests: { data: rows } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["del-risk"]).toMatchObject({ kind: "risk_deletion", title: "Delete risk: Vendor slips", project_name: "Apollo", can_decide: true });
    expect(byId["del-issue"]).toMatchObject({ kind: "issue_deletion", title: "Delete issue: Login fails" });
    expect(byId["del-expense"]).toMatchObject({ kind: "expense_deletion", title: "Delete expense: Hotel" });
    expect(byId["del-doc"]).toMatchObject({ kind: "document_deletion", title: "Delete document: Charter" });
    expect(byId["del-ms"]).toMatchObject({ kind: "milestone_deletion", title: "Delete milestone: Go-live", summary: "remove the milestone" });
  });

  it("a milestone shows how many tasks it detaches; records with nothing under them show none", async () => {
    const { db } = fullDb({ deletion_requests: { data: rows } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["del-ms"].removes).toEqual([{ label: "tasks (kept, no longer under this milestone)", count: 4, governed: false }]);
    expect(byId["del-risk"].removes).toEqual([]);
  });

  it("passes the wave-4 tier columns through, and reads them as null when the row has none", async () => {
    const { db } = fullDb({ deletion_requests: { data: rows } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["del-ms"]).toMatchObject({
      tier: "high_risk",
      approval_deadline_at: "2026-10-14T08:00:00+00:00",
    });
    expect(byId["del-risk"]).toMatchObject({ tier: null, approval_deadline_at: null });
    expect(byId["del-risk"]).not.toHaveProperty("retro_overdue");
    expect(byId["del-risk"]).not.toHaveProperty("retro_due_at");
  });

  it("asks the database for exactly the target types of the kinds wanted", async () => {
    const { db, calls } = fullDb({ deletion_requests: { data: rows } });
    await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]), { kinds: ["risk_deletion", "milestone_deletion"] });
    const del = calls.find((c) => c.table === "deletion_requests")!;
    expect(del.ops).toContainEqual(["in", ["target_type", ["risk", "milestone"]]]);
  });

  it("is hidden without the entity read scope (or audit:read), and cannot be decided without the approve scope", async () => {
    const { db } = fullDb({ deletion_requests: { data: [rows[0]] } });
    const readOnly = await listPendingApprovals(db, me, probe(["risk:read"]));
    expect(readOnly.items.map((i) => i.kind)).toEqual(["risk_deletion"]);
    expect(readOnly.items[0].can_decide).toBe(false);
    expect(readOnly.items[0].reason_if_not).toMatch(/risk:delete:approve/);
    expect(readOnly.hidden_kinds).toContain("issue_deletion");
  });

  it("the four-eyes rule holds: the requester cannot decide their own", async () => {
    const mine = rows.map((x) => ({ ...x, requested_by_id: ME }));
    const { db } = fullDb({ deletion_requests: { data: mine } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    expect(r.items.filter((i) => i.kind.endsWith("_deletion")).every((i) => !i.can_decide)).toBe(true);
  });
});

// ── W4-A rules: emergency change requests, computed retro_overdue, tier-aware can_decide ──────

describe("listPendingApprovals: tiers and emergency change requests", () => {
  const past = "2020-01-01T00:00:00+00:00";
  const emergencyCr: Row = { ...change, id: "cr-em", status: "implemented", is_emergency: true, retro_due_at: past, retro_decided_at: null, tier: "normal" };
  const asRole = (role: string) => ({ ...me, role });

  it("asks for raised and under review only: an emergency never waits and owes no retro decision", async () => {
    const { db, calls } = fullDb();
    await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const ops = calls.find((c) => c.table === "change_requests")!.ops;
    expect(JSON.stringify(ops)).not.toContain("retro_decided_at");
  });

  it("Q1: retro_overdue is gone from the payload; an emergency row only carries its tier and flag", async () => {
    const { db } = fullDb({ change_requests: { data: [emergencyCr, { ...emergencyCr, id: "cr-ok", retro_due_at: "2999-01-01T00:00:00+00:00" }] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["cr-em"]).toMatchObject({ is_emergency: true, tier: "emergency" });
    expect(byId["cr-em"]).not.toHaveProperty("retro_overdue");
  });

  it("a high_risk deletion needs an admin too; a normal one a manager is enough for", async () => {
    const hi = { ...deletionTask, id: "d-hi", tier: "high_risk" };
    const { db } = fullDb({ deletion_requests: { data: [hi, deletionProject] } });
    const r = await listPendingApprovals(db, asRole("manager"), probe([...ALL_READ, ...ALL_DECIDE]), { kinds: ["task_deletion", "project_deletion"] });
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["d-hi"].can_decide).toBe(false);
    expect(byId["del-proj"].can_decide).toBe(true);
  });
});

// ── wave 5 (R-176): deletion by request for programs, sprints, resources, allocations and clashes ──────────────

describe("listPendingApprovals — the five wave-5 register kinds", () => {
  const reg = (id: string, target_type: string, before: Row, over: Row = {}): Row => ({
    id,
    workspace_id: WS,
    target_type,
    target_id: `${target_type}-1`,
    reason: "no longer needed",
    status: "pending",
    tier: target_type === "program" ? "high_risk" : "normal",
    requested_by_type: "user",
    requested_by_id: OTHER,
    requested_by_label: "Requester A",
    before,
    created_at: "2026-10-12T08:00:00+00:00",
    ...over,
  });
  const rows = [
    reg("d-prog", "program", { name: "Payments", child_counts: { projects: 3 } }),
    reg("d-spr", "sprint", { name: "Sprint 9", project_id: "proj-1", child_counts: { tasks: 0 } }),
    reg("d-res", "resource", { name: "Dana", child_counts: { allocations: 2, allocation_ids: ["a", "b"], assigned_tasks: 1 } }),
    reg("d-alloc", "allocation", { id: "al-1", member_id: "m-1", project_id: "proj-1" }),
    reg("d-clash", "clash", { title: "Overlap on Apollo" }),
  ];

  it("lists each register request under its own kind, with a title, the reason and what approving removes", async () => {
    const { db } = fullDb({ deletion_requests: { data: rows }, change_requests: { data: [] }, rebaselines: { data: [] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["d-prog"]).toMatchObject({ kind: "program_deletion", title: "Delete program: Payments", tier: "high_risk", summary: "no longer needed" });
    expect(byId["d-spr"]).toMatchObject({ kind: "sprint_deletion", title: "Delete sprint: Sprint 9", project_name: "Apollo" });
    expect(byId["d-res"]).toMatchObject({ kind: "resource_deletion", title: "Delete resource: Dana" });
    expect(byId["d-alloc"]).toMatchObject({ kind: "allocation_deletion" });
    expect(byId["d-clash"]).toMatchObject({ kind: "clash_deletion", title: "Delete clash: Overlap on Apollo" });
    expect(byId["d-prog"].removes).toEqual([{ label: "projects (kept, no longer in this program)", count: 3, governed: false }]);
    // the assigned tasks are KEPT (only unlinked), so they are not listed as removed
    expect(byId["d-res"].removes.map((x) => x.count)).toEqual([2]);
    expect(byId["d-clash"].removes).toEqual([]);
    expect(r.total).toBe(5);
  });

  it("a kinds filter on a register kind queries only that target type", async () => {
    const { db, calls } = fullDb({ deletion_requests: { data: [rows[0]] }, change_requests: { data: [] }, rebaselines: { data: [] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]), { kinds: ["program_deletion", "clash_deletion"] });
    expect(r.items.map((i) => i.kind)).toEqual(["program_deletion"]);
    const ops = calls.find((c) => c.table === "deletion_requests")!.ops;
    expect(ops).toContainEqual(["in", ["target_type", ["program", "clash"]]]);
  });

  it("the requester cannot decide their own register request (four-eyes), someone else can", async () => {
    const own = reg("d-own", "sprint", { name: "Mine" }, { requested_by_id: ME });
    const { db } = fullDb({ deletion_requests: { data: [own, rows[1]] }, change_requests: { data: [] }, rebaselines: { data: [] } });
    const r = await listPendingApprovals(db, me, probe([...ALL_READ, ...ALL_DECIDE]));
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId["d-own"].can_decide).toBe(false);
    expect(byId["d-own"].reason_if_not).toMatch(/requested this|Raised by you/);
    expect(byId["d-spr"].can_decide).toBe(true);
  });

  it("a token without the matching read scope does not see the kind, and it is named in hidden_kinds", async () => {
    const { db } = fullDb({ deletion_requests: { data: rows }, change_requests: { data: [] }, rebaselines: { data: [] } });
    const r = await listPendingApprovals(db, { ...me, type: "token" }, probe(["task:read", "sprint:read"]));
    expect(r.hidden_kinds).toEqual(expect.arrayContaining(["program_deletion", "resource_deletion", "allocation_deletion", "clash_deletion"]));
    expect(r.hidden_kinds).not.toContain("sprint_deletion");
  });

  it("the decide scope of every register kind is an existing privileged verb (no wildcard can approve)", () => {
    for (const k of ["program_deletion", "sprint_deletion", "resource_deletion", "allocation_deletion", "clash_deletion"] as const) {
      expect(PENDING_KINDS).toContain(k);
      expect(["project:delete:approve", "task:delete:approve"]).toContain(DECIDE_SCOPES[k]);
      expect(READ_SCOPES[k]).toContain("audit:read");
    }
    expect(DECIDE_SCOPES.program_deletion).toBe("project:delete:approve");
  });
});
