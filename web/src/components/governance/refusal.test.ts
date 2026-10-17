import { describe, expect, it } from "vitest";
import type { ApiError } from "@/lib/api-client";
import { describeRefusal, fieldMessages } from "./refusal";

function apiError(message: string, extra: Partial<ApiError> = {}): ApiError {
  return Object.assign(new Error(message), extra) as ApiError;
}

describe("describeRefusal", () => {
  it("explains a four-eyes refusal in plain words and replaces the form", () => {
    const r = describeRefusal(apiError("Self-approval is not allowed (four-eyes)", { status: 403, code: "self_approval" }), "x");
    expect(r.code).toBe("self_approval");
    expect(r.title).toBe("A different person must decide");
    expect(r.detail).toContain("You raised this (directly or through your token)");
    expect(r.terminal).toBe(true);
    expect(r.stale).toBe(false);
  });

  it("tells a no_principal refusal apart from any other 403", () => {
    const r = describeRefusal(apiError("This token has no recorded owner", { status: 403, code: "no_principal" }), "x");
    expect(r.title).toMatch(/tied to a person/);
    expect(r.terminal).toBe(true);
  });

  it("treats an already-decided request as stale (refresh, then look again)", () => {
    const r = describeRefusal(apiError("Request already decided", { status: 422, code: "already_decided" }), "x");
    expect(r).toMatchObject({ title: "Already decided", terminal: true, stale: true });
  });

  it("keeps the server's own message for project_locked / children_changed", () => {
    for (const code of ["project_locked", "children_changed"]) {
      const r = describeRefusal(apiError(`server says ${code}`, { status: 422, code }), "x");
      expect(r.detail).toBe(`server says ${code}`);
      expect(r.terminal).toBe(true);
    }
    expect(describeRefusal(apiError("m", { code: "children_changed" }), "x").stale).toBe(true);
    expect(describeRefusal(apiError("m", { code: "project_locked" }), "x").stale).toBe(false);
  });

  it("reads target_changed as a stale task, with the server's message as the detail", () => {
    const r = describeRefusal(apiError("This task was edited after the deletion was requested", { status: 422, code: "target_changed" }), "x");
    expect(r).toMatchObject({
      code: "target_changed",
      title: "The task changed after this request",
      detail: "This task was edited after the deletion was requested",
      terminal: true,
      stale: true,
    });
  });

  it("reads a 412 as 'changed after you opened it', with or without a code", () => {
    const coded = describeRefusal(apiError("Record changed since you loaded it", { status: 412, code: "precondition_failed" }), "x");
    const bare = describeRefusal(apiError("Record changed since you loaded it", { status: 412 }), "x");
    for (const r of [coded, bare]) {
      expect(r).toMatchObject({ code: "precondition_failed", terminal: true, stale: true });
      expect(r.title).toBe("This changed after you opened it");
    }
  });

  it("keeps the form for input problems and unknown failures", () => {
    const fields = describeRefusal(
      apiError("Validation failed", { status: 422, code: "validation_failed", fields: [{ field: "rationale", message: "required" }] }),
      "x",
    );
    expect(fields).toMatchObject({ terminal: false, title: "Check the form" });
    const generic = describeRefusal(apiError("Internal server error", { status: 500 }), "x");
    expect(generic).toMatchObject({ terminal: false, detail: "Internal server error" });
  });

  it("falls back for a non-Error throw", () => {
    expect(describeRefusal("boom", "Could not decide.")).toMatchObject({ detail: "Could not decide.", terminal: false });
  });
});

describe("fieldMessages", () => {
  it("maps field errors by field name", () => {
    const err = apiError("bad", { fields: [{ field: "reason", message: "A reason is required" }] });
    expect(fieldMessages(err)).toEqual({ reason: "A reason is required" });
    expect(fieldMessages(new Error("plain"))).toEqual({});
    expect(fieldMessages(null)).toEqual({});
  });
});
