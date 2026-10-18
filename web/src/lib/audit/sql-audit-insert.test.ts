import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_ACTION_PATTERN,
  AUDIT_INSERT_CHANNELS,
  AUDIT_INSERT_FN,
  AUDIT_INSERT_PARAMS,
  buildAuditInsertArgs,
  buildRpcAudit,
  callAuditInsert,
} from "@/lib/audit/sql-audit-insert";
import { AUDIT_ACTION_GLOSSARY } from "@/lib/audit/action-glossary";
import { systemActor, SYSTEM_ACTOR_ID } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";

/** Text-drift test: the SQL helper (migration 0107) and its TypeScript mirror must say the same thing. */
const DIR = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(DIR).sort();
const file = files.find((f) => f.endsWith("_audit_insert_helper.sql"));
const strip = (text: string) => text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
const sql = strip(file ? readFileSync(join(DIR, file), "utf8") : "");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";

describe("migration 0107 audit insert helper", () => {
  it("exists with the planned number, directly after 0106 in ledger order", () => {
    expect(file).toBe("20261018000107_audit_insert_helper.sql");
    const idx = files.indexOf(file!);
    expect(files[idx - 1]).toBe("20261018000106_tier_decisions.sql");
  });

  it("the function's parameter list equals the TypeScript constant, in order", () => {
    const m = sql.match(/create or replace function nopm_audit_insert\( (.*?) \) returns uuid/);
    expect(m).not.toBeNull();
    const parts = m![1].split(",").map((p) => p.trim().split(" "));
    expect(parts.map((p) => p[0])).toEqual([...AUDIT_INSERT_PARAMS]);
    expect(parts.map((p) => p[1])).toEqual(["uuid", "jsonb", "uuid", "jsonb", "jsonb"]);
    expect(AUDIT_INSERT_FN).toBe("nopm_audit_insert");
  });

  it("is security definer with a pinned search_path", () => {
    expect(sql).toMatch(/\) returns uuid language plpgsql security definer set search_path = public as \$\$/);
  });

  it("is revoked from public, anon and authenticated and granted to service_role only", () => {
    expect(sql).toContain(
      "revoke execute on function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb) from public, anon, authenticated;",
    );
    const grants = sql.match(/grant [^;]*;/g) ?? [];
    expect(grants).toEqual([
      "grant execute on function nopm_audit_insert(uuid, jsonb, uuid, jsonb, jsonb) to service_role;",
    ]);
  });

  it("never writes prev_hash, row_hash or chain_seq (the 0104 trigger does)", () => {
    const body = sql.slice(sql.indexOf("insert into audit_log"), sql.indexOf("returning id into v_id"));
    expect(body.length).toBeGreaterThan(50);
    for (const col of ["prev_hash", "row_hash", "chain_seq"]) expect(body).not.toContain(col);
    expect(sql).not.toMatch(/new\.(prev_hash|row_hash|chain_seq)/);
  });

  it("inserts the same audit_log columns as nopm_mutate_audited (0103)", () => {
    const cols = (text: string) =>
      text.match(/insert into audit_log \(([^)]*)\)/)![1].split(",").map((c) => c.trim()).sort();
    const m103 = strip(readFileSync(join(DIR, "20261018000103_mutate_audited.sql"), "utf8"));
    expect(cols(sql)).toEqual(cols(m103));
    expect(cols(sql)).toHaveLength(15);
  });

  it("the action validation regex matches the TypeScript one", () => {
    const m = sql.match(/v_action !~ '([^']+)'/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(AUDIT_ACTION_PATTERN.source);
    expect(sql).toContain("using errcode = 'p0057'");
  });

  it("the channel list matches the TypeScript list and keeps the 0103 error code", () => {
    const m = sql.match(/v_channel not in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...AUDIT_INSERT_CHANNELS]);
    expect(sql).toMatch(/raise exception 'invalid_channel' using errcode = 'p0005'/);
  });

  it("reserves the nil actor id for the system actor", () => {
    expect(sql).toContain("c_nil constant uuid := '00000000-0000-0000-0000-000000000000'");
    expect(SYSTEM_ACTOR_ID).toBe("00000000-0000-0000-0000-000000000000");
    expect(sql).toContain("v_actor = c_nil and (v_type <> 'token' or v_label not like 'system:%' or v_princ is not null)");
  });

  it("only requires a non-null actor_label, like writeAudit and 0103 (W1-09)", () => {
    expect(sql).toContain("if v_label is null then");
    expect(sql).not.toContain("btrim(v_label)");
  });

  it("creates nothing but the one function", () => {
    expect(sql.match(/\bcreate (?:or replace )?(?:table|index|unique index|trigger|type|view|extension)\b/g)).toBeNull();
    expect(sql.match(/\b(?:alter|drop|truncate)\s+(?:table|trigger|index|type)\b/g)).toBeNull();
    expect(sql.match(/create or replace function/g)).toHaveLength(1);
  });
});

describe("sql-audit-insert.ts", () => {
  const user: Actor = { type: "user", id: USER, label: "ana@example.com", workspaceId: WS, channel: "ui", requestId: "req-1" };
  const connector: Actor = {
    type: "token", id: CONNECTOR, label: "lark:ou_x", workspaceId: WS, principalId: USER,
    channel: "lark", requestId: "req-2", viaConnectorId: CONNECTOR, externalEventId: "ev-1", externalActorRef: "lark:t:ou_x",
  };

  it("every glossary action matches the action pattern", () => {
    for (const e of AUDIT_ACTION_GLOSSARY) expect(AUDIT_ACTION_PATTERN.test(e.action), e.action).toBe(true);
  });

  it("builds the exact argument object for a user actor", () => {
    const args = buildAuditInsertArgs({
      workspaceId: WS, actor: user, action: "task.update", targetType: "task", targetId: USER, before: { a: 1 }, after: { a: 2 },
    });
    expect(Object.keys(args)).toEqual([...AUDIT_INSERT_PARAMS]);
    expect(args.p_audit).toEqual({
      action: "task.update", target_type: "task", actor_type: "user", actor_id: USER, actor_label: "ana@example.com",
      channel: "ui", request_id: "req-1", principal_id: USER, via_connector_id: null, external_event_id: null, external_actor_ref: null,
    });
    expect(args).toMatchObject({ p_workspace_id: WS, p_target_id: USER, p_before: { a: 1 }, p_after: { a: 2 } });
  });

  it("builds a connector actor with provenance and a system actor with no principal", () => {
    const c = buildAuditInsertArgs({ workspaceId: WS, actor: connector, action: "change_request.create", targetType: "change_request" });
    expect(c.p_audit).toMatchObject({
      via_connector_id: CONNECTOR, external_event_id: "ev-1", external_actor_ref: "lark:t:ou_x", principal_id: USER, channel: "lark",
    });
    expect(c).toMatchObject({ p_target_id: null, p_before: null, p_after: null });

    const s = buildAuditInsertArgs({
      workspaceId: WS, actor: systemActor(WS, "weekly-report", { channel: "api" }), action: "report.sent", targetType: "workspace",
    });
    expect(s.p_audit).toMatchObject({ actor_type: "token", actor_id: SYSTEM_ACTOR_ID, actor_label: "system:weekly-report", principal_id: null });
  });

  it("buildRpcAudit carries overrides on top of the same actor fields", () => {
    const base = buildRpcAudit(user, "task.update", "task");
    expect(base).toEqual(buildAuditInsertArgs({ workspaceId: WS, actor: user, action: "task.update", targetType: "task" }).p_audit);
    expect(buildRpcAudit(user, "task.update", "task", { auditTargetId: CONNECTOR })).toMatchObject({ target_id: CONNECTOR });
  });

  it("rejects an action or channel the SQL helper would reject", () => {
    expect(() => buildAuditInsertArgs({ workspaceId: WS, actor: user, action: "Task Update", targetType: "task" })).toThrow(/Invalid audit action/);
    expect(() => buildAuditInsertArgs({ workspaceId: WS, actor: user, action: "task", targetType: "task" })).toThrow(/Invalid audit action/);
    expect(() =>
      buildAuditInsertArgs({ workspaceId: WS, actor: { ...user, channel: "fax" as never }, action: "task.update", targetType: "task" }),
    ).toThrow(/Invalid audit channel/);
  });

  it("callAuditInsert returns the id and fails closed", async () => {
    const args = buildAuditInsertArgs({ workspaceId: WS, actor: user, action: "task.update", targetType: "task" });
    const calls: unknown[] = [];
    const ok = {
      rpc: (fn: string, a: Record<string, unknown>) => {
        calls.push([fn, a]);
        return Promise.resolve({ data: "row-id", error: null });
      },
    };
    await expect(callAuditInsert(ok, args)).resolves.toBe("row-id");
    expect(calls).toEqual([["nopm_audit_insert", args]]);
    const bad = { rpc: () => Promise.resolve({ data: null, error: { message: "INVALID_ACTION: x" } }) };
    await expect(callAuditInsert(bad, args)).rejects.toThrow(/Fail-closed audit write failed: INVALID_ACTION/);
    const none = { rpc: () => Promise.resolve({ data: null, error: null }) };
    await expect(callAuditInsert(none, args)).rejects.toThrow(/no audit row id/);
  });
});
