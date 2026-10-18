import { describe, it, expect } from "vitest";
import { auditCanonical, auditRowHash, jsonbText, type AuditHashRow } from "./hash";

/**
 * Pins the audit hash chain (migration 0104). The SQL function nopm_audit_canonical and this
 * TypeScript copy must stay identical; the constants below are the contract. If you change the
 * canonical form, change BOTH, write a migration that re-hashes (the chain is append-only), and
 * update the constants deliberately.
 */
const WS = "11111111-1111-4111-8111-111111111111";
const first: AuditHashRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  workspace_id: WS,
  actor_type: "user",
  actor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  actor_label: "Ada",
  principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  action: "task.create",
  target_type: "task",
  target_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  before: null,
  after: { name: "Pour slab", id: 7, status: "todo", tags: ["a", "b"], done: false },
  channel: "ui",
  request_id: "req-1",
  created_at: "2026-10-18T01:02:03.456789Z",
  via_connector_id: null,
  external_event_id: null,
  external_actor_ref: null,
  chain_seq: 1,
};
const second: AuditHashRow = {
  ...first,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  action: "task.update",
  before: { status: "todo" },
  after: { status: "doing" },
  channel: "lark",
  via_connector_id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
  external_event_id: "evt-9",
  external_actor_ref: "lark:t1:ou_x",
  created_at: "2026-10-18T01:02:04.000001Z",
  chain_seq: 2,
};

const FIRST_HASH = "a52366a6749d89a8a71cfc929f347933d840e6b80f868f0fa28f88f71e13294c";
const SECOND_HASH = "1a036863cc161fd4be287dab61d1b5747fa4455ce69820e387e9c986a31d1a69";

describe("audit hash chain reference implementation", () => {
  it("prints jsonb the way Postgres does (key order by length then bytes, ', ' and ': ')", () => {
    expect(jsonbText({ bb: 1, a: [1, null, "x"], ccc: { z: true, y: null } })).toBe(
      '{"a": [1, null, "x"], "bb": 1, "ccc": {"y": null, "z": true}}',
    );
  });

  it("canonical text is a jsonb array with nulls kept in place", () => {
    expect(auditCanonical(first)).toBe(
      '["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "11111111-1111-4111-8111-111111111111", "user", ' +
        '"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "Ada", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", "task.create", ' +
        '"task", "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", null, ' +
        '{"id": 7, "done": false, "name": "Pour slab", "tags": ["a", "b"], "status": "todo"}, ' +
        '"ui", "req-1", "2026-10-18T01:02:03.456789Z", null, null, null, 1]',
    );
  });

  it("the first row chains from an empty prev_hash and matches the pinned constant", () => {
    expect(auditRowHash(null, first)).toBe(FIRST_HASH);
  });

  it("the second row (connector provenance included) chains from the first and matches the pinned constant", () => {
    expect(auditRowHash(FIRST_HASH, second)).toBe(SECOND_HASH);
  });

  it("changing any field, or the previous hash, changes the hash", () => {
    expect(auditRowHash(null, { ...first, actor_label: "Eve" })).not.toBe(FIRST_HASH);
    expect(auditRowHash(null, { ...first, after: { ...(first.after as object), id: 8 } })).not.toBe(FIRST_HASH);
    expect(auditRowHash(null, { ...first, chain_seq: 2 })).not.toBe(FIRST_HASH);
    expect(auditRowHash("x", first)).not.toBe(FIRST_HASH);
  });
});
