import { describe, it, expect } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { approvalIsStale, assertMayApproveDocument, documentContentChanged } from "./approval";

const user = (role: string, id = "u1") =>
  ({ type: "user", id, label: id, workspaceId: "w", role, principalId: id }) as Actor;

describe("assertMayApproveDocument", () => {
  it("lets a manager other than the author approve", () => {
    expect(() => assertMayApproveDocument(user("manager", "m1"), "author")).not.toThrow();
  });
  it("refuses a member", () => {
    expect(() => assertMayApproveDocument(user("member"), "author")).toThrow(/manager or admin other than the author/);
  });
  it("refuses the author even if a manager or admin", () => {
    expect(() => assertMayApproveDocument(user("admin", "a1"), "a1")).toThrow(/other than the author/);
  });
  it("judges a token by its creator's role", () => {
    const t = { type: "token", id: "t", label: "t", workspaceId: "w", principalRole: "member", principalId: "x" } as Actor;
    expect(() => assertMayApproveDocument(t, null)).toThrow();
  });
});

describe("documentContentChanged / approvalIsStale", () => {
  const existing = { title: "A", body: "x", summary: null, status: "approved" };
  it("detects a real content change only", () => {
    expect(documentContentChanged(existing, { body: "y" })).toBe(true);
    expect(documentContentChanged(existing, { body: "x", summary: null })).toBe(false);
    expect(documentContentChanged(existing, {})).toBe(false);
  });
  it("sends an approved document back to draft on edit", () => {
    expect(approvalIsStale("approved", undefined, true)).toBe(true);
    expect(approvalIsStale("approved", "approved", true)).toBe(true);
    expect(approvalIsStale("approved", "archived", true)).toBe(false);
    expect(approvalIsStale("approved", undefined, false)).toBe(false);
    expect(approvalIsStale("draft", undefined, true)).toBe(false);
  });
});
