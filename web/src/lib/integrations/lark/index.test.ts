import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApprovalDecidedEvent, ApprovalEvent } from "@/lib/integrations/types";

const client = vi.hoisted(() => ({
  sendCard: vi.fn(),
  patchCard: vi.fn(),
  testBot: vi.fn(),
}));
vi.mock("./client", () => client);

import { larkAdapter } from "./index";
import { fixtureConnector, fixtureSecrets } from "./fixtures";

const ev: ApprovalEvent = {
  workspaceId: "w1",
  kind: "change_request",
  id: "55555555-5555-4555-8555-555555555555",
  title: "CR-7: add a milestone",
  requestedByLabel: "Riley Requester",
  requesterPrincipalId: null,
};

beforeEach(() => vi.clearAllMocks());

describe("larkAdapter", () => {
  it("identifies as the lark kind", () => {
    expect(larkAdapter.kind).toBe("lark");
  });

  it("renders an approval card carrying the action token", () => {
    const card = larkAdapter.renderApprovalCard(ev, { actionToken: "npa_tok", appUrl: "https://nopm.example.test" });
    expect(card.schema).toBe("2.0");
    expect(JSON.stringify(card)).toContain("npa_tok");
    expect(JSON.stringify(card)).toContain("https://nopm.example.test/change-control?cr=55555555-5555-4555-8555-555555555555");
  });

  it("renders a button-free decision update", () => {
    const decided: ApprovalDecidedEvent = { ...ev, status: "rejected", decidedByLabel: "Sam Approver", channel: "lark" };
    const card = larkAdapter.renderDecisionUpdate(decided, { appUrl: "https://nopm.example.test" });
    expect(JSON.stringify(card)).not.toContain('"button"');
    expect(JSON.stringify(card)).toContain("Rejected");
    expect(JSON.stringify(card)).toContain("via Lark");
  });

  it("renders a digest", () => {
    const card = larkAdapter.renderDigest({
      workspaceName: "Programme Office",
      generatedAt: "2026-10-16T09:00:00.000Z",
      appUrl: "https://nopm.example.test",
      projects: [],
      milestonesDueSoon: [],
      openHighRisks: 0,
      pendingApprovals: 0,
    });
    expect((card.header as { title: { content: string } }).title.content).toContain("Programme Office");
  });

  it("delegates transport to the client", async () => {
    const connector = fixtureConnector();
    const secrets = fixtureSecrets();
    client.sendCard.mockResolvedValue({ ok: true, externalMessageId: "om_1" });
    client.patchCard.mockResolvedValue({ ok: true, externalMessageId: "om_1" });
    client.testBot.mockResolvedValue({ ok: true, botName: "NoPM Bot" });

    const msg = { receiveIdType: "open_id" as const, receiveId: "ou_1", body: { schema: "2.0" } };
    expect(await larkAdapter.send(connector, secrets, msg)).toEqual({ ok: true, externalMessageId: "om_1" });
    expect(client.sendCard).toHaveBeenCalledWith(connector, secrets, msg);

    expect(await larkAdapter.update(connector, secrets, "om_1", { schema: "2.0" })).toEqual({ ok: true, externalMessageId: "om_1" });
    expect(client.patchCard).toHaveBeenCalledWith(connector, secrets, "om_1", { schema: "2.0" });

    expect(await larkAdapter.testConnection(connector, secrets)).toEqual({ ok: true, botName: "NoPM Bot" });
    expect(client.testBot).toHaveBeenCalledWith(connector, secrets);
  });
});
