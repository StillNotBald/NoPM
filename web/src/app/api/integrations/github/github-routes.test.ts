import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { decryptWebhookSecret } from "@/lib/integrations/github/secrets";
import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids } from "@/lib/integrations/test-support";
import { DELETE, GET, PATCH, POST } from "./connector/route";
import { GET as GET_EVENTS } from "./work-events/route";

const NO_PARAMS = { params: Promise.resolve({}) };
const URL_ = "http://localhost:3000/api/integrations/github/connector";

const admin = (over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id: ids.admin,
  label: "Ada Admin",
  workspaceId: WS,
  role: "admin",
  principalId: ids.admin,
  ...over,
});

const send = (fn: typeof POST, method: string, body?: unknown) =>
  fn(
    new NextRequest(URL_, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    NO_PARAMS,
  );

let db: FakeDb;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(admin());
  db = new FakeDb();
  db.seed("workspaces", [{ id: WS, name: "Acme PMO" }]);
  state.db = db;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/integrations/github/connector", () => {
  it("creates a connector, returns the secret once, stores only ciphertext and audits without the secret", async () => {
    const res = await send(POST, "POST", { name: "Team GitHub" });
    const body = (await res.json()) as { data: Record<string, string> };
    expect(res.status).toBe(201);
    expect(body.data.webhook_secret).toMatch(/^npg_/);
    expect(body.data.webhook_url).toBe(`http://localhost:3000/api/integrations/github/${body.data.id}/events`);

    const row = db.rows("integration_connectors")[0];
    expect(row).toMatchObject({ kind: "github", workspace_id: WS, status: "active" });
    expect(JSON.stringify(row)).not.toContain(body.data.webhook_secret);
    expect(decryptWebhookSecret(row.secret_enc as string)).toBe(body.data.webhook_secret);

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(writeAuditMock.mock.calls[0][0])).not.toContain(body.data.webhook_secret);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "integration.connector.create" });
  });

  it("refuses a second live connector and non-admins", async () => {
    await send(POST, "POST", {});
    expect((await send(POST, "POST", {})).status).toBe(422);
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await send(POST, "POST", {})).status).toBe(403);
    requireAuthMock.mockResolvedValue(admin({ type: "token", role: undefined }));
    expect((await send(POST, "POST", {})).status).toBe(403);
  });

  it("rejects an empty name", async () => {
    expect((await send(POST, "POST", { name: "   " })).status).toBe(422);
  });
});

describe("GET / PATCH / DELETE", () => {
  it("shows an admin the webhook URL, a member only that it exists, and never the secret", async () => {
    const created = (await (await send(POST, "POST", {})).json()) as { data: Record<string, string> };
    const adminView = (await (await send(GET, "GET")).json()) as { data: Record<string, unknown> };
    expect(JSON.stringify(adminView)).not.toContain(created.data.webhook_secret);
    expect(adminView.data.can_manage).toBe(true);
    expect((adminView.data.connector as Record<string, unknown>).webhook_url).toContain("/events");

    requireAuthMock.mockResolvedValue(admin({ role: "member" }));
    const memberView = (await (await send(GET, "GET")).json()) as { data: { connector: Record<string, unknown>; can_manage: boolean } };
    expect(memberView.data.can_manage).toBe(false);
    expect(memberView.data.connector).toEqual({ name: "GitHub", status: "active" });
  });

  it("changes the mapping, validates it, audits the change and keeps untouched events", async () => {
    const ok = await send(PATCH, "PATCH", { rules: { pr_opened: "unstarted", deploy_failure: "canceled" } });
    const data = ((await ok.json()) as { data: { rules: Record<string, unknown> } }).data;
    expect(ok.status).toBe(200);
    expect(data.rules).toMatchObject({ pr_opened: "unstarted", deploy_failure: "canceled", pr_merged: "in_review", deploy_success: "completed" });
    expect(db.rows("workspaces")[0].work_event_rules).toMatchObject({ pr_opened: "unstarted" });
    expect(writeAuditMock.mock.calls.at(-1)?.[0]).toMatchObject({ action: "work_event_rules.update" });

    expect((await send(PATCH, "PATCH", { rules: { pr_opened: "done" } })).status).toBe(422);
    expect((await send(PATCH, "PATCH", { rules: { wat: "started" } })).status).toBe(422);
    expect((await send(PATCH, "PATCH", { bogus: 1 })).status).toBe(422);
    expect((await send(PATCH, "PATCH", {})).status).toBe(422);
    requireAuthMock.mockResolvedValue(admin({ role: "member" }));
    expect((await send(PATCH, "PATCH", { rules: { pr_opened: "started" } })).status).toBe(403);
  });

  it("pauses, resumes and rotates the secret (returned once, the old one stops working)", async () => {
    await send(POST, "POST", {});
    const first = decryptWebhookSecret(db.rows("integration_connectors")[0].secret_enc as string);
    expect(((await (await send(PATCH, "PATCH", { status: "paused" })).json()) as { data: { connector: { status: string } } }).data.connector.status).toBe("paused");
    const rotated = (await (await send(PATCH, "PATCH", { rotate_secret: true })).json()) as { data: { webhook_secret: string } };
    expect(rotated.data.webhook_secret).toMatch(/^npg_/);
    expect(rotated.data.webhook_secret).not.toBe(first);
    expect(decryptWebhookSecret(db.rows("integration_connectors")[0].secret_enc as string)).toBe(rotated.data.webhook_secret);
    expect((await send(PATCH, "PATCH", { status: "revoked" })).status).toBe(422);
  });

  it("answers 404 for connector changes when none exists, and revokes to free the slot", async () => {
    expect((await send(PATCH, "PATCH", { status: "paused" })).status).toBe(404);
    expect((await send(DELETE, "DELETE")).status).toBe(404);
    await send(POST, "POST", {});
    expect((await send(DELETE, "DELETE")).status).toBe(200);
    expect(db.rows("integration_connectors")[0]).toMatchObject({ status: "revoked" });
    expect((await send(POST, "POST", {})).status).toBe(201);
  });
});

describe("GET /api/integrations/github/work-events", () => {
  it("lists the workspace's events newest first and nothing from another workspace", async () => {
    db.seed("work_events", [
      { id: "e1", workspace_id: WS, kind: "pr_opened", ref: "a/b#1", received_at: "2026-10-18T08:00:00.000Z", applied: true, reason: "applied" },
      { id: "e2", workspace_id: WS, kind: "pr_merged", ref: "a/b#1", received_at: "2026-10-18T09:00:00.000Z", applied: false, reason: "project_locked" },
      { id: "e3", workspace_id: "22222222-2222-4222-8222-222222222222", kind: "pr_opened", ref: "x/y#1", received_at: "2026-10-18T10:00:00.000Z", applied: true, reason: "applied" },
    ]);
    const res = await GET_EVENTS(new NextRequest("http://localhost:3000/api/integrations/github/work-events?limit=20"), NO_PARAMS);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(res.status).toBe(200);
    expect(body.data.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("is not available to a token", async () => {
    requireAuthMock.mockResolvedValue(admin({ type: "token", role: undefined }));
    const res = await GET_EVENTS(new NextRequest("http://localhost:3000/api/integrations/github/work-events"), NO_PARAMS);
    expect(res.status).toBe(403);
  });
});

describe("task external_ref schema (GitHub links)", () => {
  it("requires github:<owner>/<repo>#<n> in lower case for a GitHub link and leaves other systems alone", async () => {
    const { TaskCreateSchema, TaskUpdateSchema } = await import("@/app/api/tasks/_schema");
    const ok = TaskUpdateSchema.safeParse({ source: "github", external_ref: "github:acme/widgets#7" });
    expect(ok.success).toBe(true);
    for (const bad of ["acme/widgets#7", "github:Acme/widgets#7", "github:acme/widgets#0", "github:acme#7", "PROJ-1"]) {
      const r = TaskUpdateSchema.safeParse({ source: "github", external_ref: bad });
      expect(r.success, bad).toBe(false);
    }
    expect(TaskCreateSchema.safeParse({ name: "x", external_ref: "github:acme/widgets" }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ name: "x", source: "jira", external_ref: "PROJ-1" }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ source: "github" }).success).toBe(true);
    expect(TaskUpdateSchema.safeParse({ external_ref: null, source: null }).success).toBe(true);
  });
});

describe("connector kind isolation", () => {
  it("the Lark connector lookup never returns a GitHub connector", async () => {
    const { getConnector } = await import("@/lib/integrations/store");
    await send(POST, "POST", {});
    const id = db.rows("integration_connectors")[0].id as string;
    expect(await getConnector(WS, id)).toBeNull();
  });
});
