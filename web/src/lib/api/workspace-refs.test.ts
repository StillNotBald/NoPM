/**
 * Cross-tenant reference guard (R1 M3): assertRefsInWorkspace.
 *
 *  - an id in the caller's workspace passes; an id in ANOTHER workspace, and an
 *    id that does not exist, both fail with the SAME 422 message (no oracle)
 *  - null / undefined ids are skipped (clearing a reference is allowed)
 *  - a non-UUID is a field error and never reaches the database
 *  - lookups are batched: ONE query per table (and per extra constraint set)
 *  - `match` adds equality constraints (same-project checks)
 *  - every offending field is reported in one 422, with the zod-compatible
 *    `{ error, fields }` body plus code `invalid_reference`
 *  - a failed lookup fails closed (throws, never passes)
 */
import { describe, it, expect } from "vitest";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";
import { FieldsError, toErrorResponse } from "@/lib/api/errors";
import { assertRefsInWorkspace, REF_TABLES } from "./workspace-refs";
import type { SupabaseClient } from "@supabase/supabase-js";

const W1 = "ws-1";
const W2 = "ws-2";

const PROJ_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const PROJ_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const PROJ_W2 = "aaaaaaaa-0000-4000-8000-0000000000f2";
const USER_1 = "bbbbbbbb-0000-4000-8000-000000000001";
const USER_W2 = "bbbbbbbb-0000-4000-8000-0000000000f2";
const MEMBER_1 = "cccccccc-0000-4000-8000-000000000001";
const MILESTONE_P1 = "dddddddd-0000-4000-8000-000000000001";
const MISSING = "eeeeeeee-0000-4000-8000-000000000000";

function world() {
  return new FakeDb({
    projects: [
      { id: PROJ_1, workspace_id: W1 },
      { id: PROJ_2, workspace_id: W1 },
      { id: PROJ_W2, workspace_id: W2 },
    ],
    profiles: [
      { id: USER_1, workspace_id: W1 },
      { id: USER_W2, workspace_id: W2 },
    ],
    resource_members: [{ id: MEMBER_1, workspace_id: W1 }],
    milestones: [{ id: MILESTONE_P1, workspace_id: W1, project_id: PROJ_1 }],
  });
}

const client = (db: FakeDb) => db.client as unknown as SupabaseClient;

/** Count the SELECTs a FakeDb received per table (wraps client.from). */
function spyOnFrom(db: FakeDb) {
  const calls: string[] = [];
  const from = db.client.from;
  db.client.from = ((table: string) => {
    calls.push(table);
    return from(table);
  }) as typeof db.client.from;
  return calls;
}

async function failure(p: Promise<void>): Promise<FieldsError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FieldsError);
    return e as FieldsError;
  }
  throw new Error("expected assertRefsInWorkspace to throw");
}

describe("assertRefsInWorkspace — what passes", () => {
  it("resolves when every referenced row is in the caller's workspace", async () => {
    const db = world();
    await expect(
      assertRefsInWorkspace(client(db), W1, [
        { table: "profiles", id: USER_1, field: "owner_id" },
        { table: "projects", id: PROJ_1, field: "project_id" },
        { table: "resource_members", id: MEMBER_1, field: "assignee_id" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("skips null and undefined ids (clearing a reference is always allowed)", async () => {
    const db = world();
    const calls = spyOnFrom(db);
    await expect(
      assertRefsInWorkspace(client(db), W1, [
        { table: "profiles", id: null, field: "owner_id" },
        { table: "projects", id: undefined, field: "project_id" },
      ]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is a no-op for an empty ref list", async () => {
    const db = world();
    const calls = spyOnFrom(db);
    await expect(assertRefsInWorkspace(client(db), W1, [])).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("accepts an upper-case UUID that matches a stored lower-case id", async () => {
    const db = world();
    await expect(
      assertRefsInWorkspace(client(db), W1, [{ table: "projects", id: PROJ_1.toUpperCase(), field: "project_id" }]),
    ).resolves.toBeUndefined();
  });
});

describe("assertRefsInWorkspace — cross-tenant and missing ids", () => {
  it("rejects an id that lives in ANOTHER workspace (422, invalid_reference, field named)", async () => {
    const db = world();
    const err = await failure(
      assertRefsInWorkspace(client(db), W1, [{ table: "profiles", id: USER_W2, field: "owner_id" }]),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("invalid_reference");
    expect(err.fields).toEqual([{ field: "owner_id", message: "owner_id was not found in this workspace" }]);
  });

  it("gives a foreign id and a non-existent id the SAME message (no existence oracle)", async () => {
    const db = world();
    const foreign = await failure(
      assertRefsInWorkspace(client(db), W1, [{ table: "projects", id: PROJ_W2, field: "project_id" }]),
    );
    const missing = await failure(
      assertRefsInWorkspace(client(db), W1, [{ table: "projects", id: MISSING, field: "project_id" }]),
    );
    expect(foreign.fields).toEqual(missing.fields);
    expect(foreign.message).toBe(missing.message);
  });

  it("reports every offending field in a single 422", async () => {
    const db = world();
    const err = await failure(
      assertRefsInWorkspace(client(db), W1, [
        { table: "profiles", id: USER_W2, field: "owner_id" },
        { table: "projects", id: PROJ_1, field: "project_a_id" },
        { table: "projects", id: PROJ_W2, field: "project_b_id" },
      ]),
    );
    expect(err.fields.map((f) => f.field)).toEqual(["owner_id", "project_b_id"]);
  });

  it("is workspace-relative: the same id passes for its own workspace and fails for another", async () => {
    const db = world();
    await expect(
      assertRefsInWorkspace(client(db), W2, [{ table: "projects", id: PROJ_W2, field: "project_id" }]),
    ).resolves.toBeUndefined();
    await failure(assertRefsInWorkspace(client(db), W2, [{ table: "projects", id: PROJ_1, field: "project_id" }]));
  });

  it("maps to the zod-compatible 422 body: { error, code, fields }", async () => {
    const db = world();
    const err = await failure(
      assertRefsInWorkspace(client(db), W1, [{ table: "profiles", id: USER_W2, field: "owner_id" }]),
    );
    const res = toErrorResponse(err);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Referenced record not found in this workspace",
      code: "invalid_reference",
      fields: [{ field: "owner_id", message: "owner_id was not found in this workspace" }],
    });
  });
});

describe("assertRefsInWorkspace — malformed ids", () => {
  it.each(["not-a-uuid", "../unlock", "1; drop table x", "", "aaaaaaaa-0000-4000-8000-00000000000g"])(
    "rejects %j as a field error without touching the database",
    async (bad) => {
      const db = world();
      const calls = spyOnFrom(db);
      const err = await failure(
        assertRefsInWorkspace(client(db), W1, [{ table: "projects", id: bad, field: "project_id" }]),
      );
      expect(err.fields).toEqual([{ field: "project_id", message: "project_id must be a valid UUID" }]);
      expect(calls).toEqual([]);
    },
  );

  it("rejects a non-string id", async () => {
    const db = world();
    await failure(
      assertRefsInWorkspace(client(db), W1, [{ table: "projects", id: 42 as unknown as string, field: "project_id" }]),
    );
  });
});

describe("assertRefsInWorkspace — batching and constraints", () => {
  it("issues ONE query per table, however many ids reference it", async () => {
    const db = world();
    const calls = spyOnFrom(db);
    await assertRefsInWorkspace(client(db), W1, [
      { table: "projects", id: PROJ_1, field: "project_a_id" },
      { table: "projects", id: PROJ_2, field: "project_b_id" },
      { table: "projects", id: PROJ_1, field: "project_id" },
      { table: "profiles", id: USER_1, field: "owner_id" },
    ]);
    expect(calls.filter((t) => t === "projects")).toHaveLength(1);
    expect(calls.filter((t) => t === "profiles")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("enforces `match` constraints (a milestone must belong to the same project)", async () => {
    const db = world();
    await expect(
      assertRefsInWorkspace(client(db), W1, [
        { table: "milestones", id: MILESTONE_P1, field: "milestone_id", match: { project_id: PROJ_1 } },
      ]),
    ).resolves.toBeUndefined();
    const err = await failure(
      assertRefsInWorkspace(client(db), W1, [
        { table: "milestones", id: MILESTONE_P1, field: "milestone_id", match: { project_id: PROJ_2 } },
      ]),
    );
    expect(err.fields[0].field).toBe("milestone_id");
  });

  it("queries refs with different constraint sets separately", async () => {
    const db = world();
    const calls = spyOnFrom(db);
    await assertRefsInWorkspace(client(db), W1, [
      { table: "milestones", id: MILESTONE_P1, field: "a", match: { project_id: PROJ_1 } },
      { table: "milestones", id: MILESTONE_P1, field: "b" },
    ]);
    expect(calls.filter((t) => t === "milestones")).toHaveLength(2);
  });
});

describe("assertRefsInWorkspace — fail closed", () => {
  it("throws (does not pass) when a lookup errors", async () => {
    const broken = {
      from: () => ({
        select: () => ({
          eq: () => ({ in: async () => ({ data: null, error: { message: "boom" } }) }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(
      assertRefsInWorkspace(broken, W1, [{ table: "projects", id: PROJ_1, field: "project_id" }]),
    ).rejects.toThrow(/lookup failed: boom/);
  });
});

describe("REF_TABLES", () => {
  it("lists only tables the schema scopes by workspace_id", () => {
    // Guard against someone adding a table without a workspace_id column.
    expect([...REF_TABLES].sort()).toEqual(
      [
        "change_requests",
        "clashes",
        "decisions",
        "documents",
        "issues",
        "milestones",
        "profiles",
        "programs",
        "projects",
        "resource_members",
        "risks",
        "sprints",
        "tasks",
      ].sort(),
    );
  });
});
