import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { decideMock, signoffMock } = vi.hoisted(() => ({ decideMock: vi.fn(), signoffMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/governance/decide", () => ({ decideApproval: decideMock, changeRequestEvent: vi.fn() }));
vi.mock("@/lib/integrations/rebaseline-approval", () => ({ signoffRebaseline: signoffMock }));
vi.mock("@/lib/integrations/emit", () => ({ schedule: vi.fn(), runApprovalChanged: vi.fn() }));

import { ScopeError } from "@/lib/api/errors";
import { handleApprovalAction } from "./inbound";
import { buildApprovalRequestCard, deepLinkFor, KIND_LABEL } from "./lark/cards";
import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, linkIdentity, seedWorkspace } from "./test-support";
import type { ConnectorRow } from "./types";

const RAW = "npa_raw-token-for-rebaseline-0123456789";
const RB = "c0000000-0000-4000-8000-000000000009";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

let db: FakeDb;
let connector: ConnectorRow;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  decideMock.mockReset();
  signoffMock.mockReset();
  signoffMock.mockResolvedValue({ kind: "rebaseline_signoff", id: RB, status: "approved", title: "Rebaseline v2: Apollo", requesterPrincipalId: ids.requester });
  db = new FakeDb();
  state.db = db;
  connector = seedWorkspace(db);
  linkIdentity(db, ids.manager, "ou_max");
  db.seed("action_tokens", [
    {
      id: "tok-rb",
      workspace_id: WS,
      delivery_id: "d1",
      recipient_profile_id: ids.manager,
      approval_kind: "rebaseline_signoff",
      approval_id: RB,
      token_hash: sha(RAW),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      used_at: null,
    },
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const input = (over = {}) => ({
  connector,
  externalEventId: "evt-rb",
  externalTenant: "tenant-1",
  externalUserId: "ou_max",
  actionToken: RAW,
  action: "approve" as const,
  ...over,
});

describe("Lark rebaseline sign-off", () => {
  it("Approve casts the vote go through signoffRebaseline, never decideApproval", async () => {
    const out = await handleApprovalAction(input());
    expect(out).toMatchObject({ status: "decided", action: "approve", ref: { kind: "rebaseline_signoff", id: RB }, newStatus: "approved" });
    expect(signoffMock).toHaveBeenCalledTimes(1);
    expect(signoffMock.mock.calls[0].slice(1)).toEqual([RB, "go", undefined]);
    expect(signoffMock.mock.calls[0][0]).toMatchObject({ principalId: ids.manager, channel: "lark" });
    expect(decideMock).not.toHaveBeenCalled();
  });

  it("Reject needs a reason and votes no_go with it", async () => {
    expect(await handleApprovalAction(input({ action: "reject", note: "  " }))).toMatchObject({ status: "invalid" });
    expect(signoffMock).not.toHaveBeenCalled();
    await handleApprovalAction(input({ action: "reject", note: "Too tight", externalEventId: "evt-rb2" }));
    expect(signoffMock.mock.calls[0].slice(1)).toEqual([RB, "no_go", "Too tight"]);
  });

  it("a refused self-sign-off does not burn the card (Q-ACC-15)", async () => {
    signoffMock.mockRejectedValue(new ScopeError("Four-eyes", "self_approval"));
    expect(await handleApprovalAction(input())).toEqual({ status: "self_approval" });
    expect(db.rows("action_tokens")[0].used_at).toBeNull();
  });

  it("a successful vote spends the card", async () => {
    await handleApprovalAction(input());
    expect(db.rows("action_tokens")[0].used_at).not.toBeNull();
  });
});

describe("rebaseline card", () => {
  it("is labelled, links to Baselines, and says Approve signs off (apply stays in NoPM)", () => {
    expect(KIND_LABEL.rebaseline_signoff).toBe("Rebaseline sign-off");
    expect(deepLinkFor("https://pm.example.test", { kind: "rebaseline_signoff", id: RB })).toBe("https://pm.example.test/baselines");
    const card = JSON.stringify(
      buildApprovalRequestCard(
        { workspaceId: WS, kind: "rebaseline_signoff", id: RB, title: "Rebaseline v2: Apollo", requestedByLabel: "Rae", requesterPrincipalId: ids.requester },
        { actionToken: "t", appUrl: "https://pm.example.test" },
      ),
    );
    expect(card).toContain("Rebaseline sign-off: approval needed");
    expect(card).toContain("signs off the new dates");
    expect(card).toContain('"a":"approve"');
    expect(card).toContain('"a":"reject"');
  });
});
