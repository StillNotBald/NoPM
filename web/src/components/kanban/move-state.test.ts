import { describe, expect, it, vi } from "vitest";
import {
  expireSaved,
  failureMessage,
  persistMove,
  rejectionReason,
  withMove,
  type MoveStates,
} from "./move-state";

const res = (status: number, body?: unknown, jsonThrows = false) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonThrows) throw new Error("not json");
      return body;
    },
  }) as unknown as Response;

describe("persistMove", () => {
  it("is ok only when the API answers 2xx, and sends the status change as a PATCH", async () => {
    const fetchImpl = vi.fn(async () => res(200, { data: {} }));
    const out = await persistMove("t1", "completed", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tasks/t1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status_type: "completed" }),
    });
  });

  it("relays the API's own reason when a move is refused (lock / rule)", async () => {
    const fetchImpl = vi.fn(async () => res(422, { error: "Project is locked; rebaseline to change status." }));
    const out = await persistMove("t1", "started", fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ ok: false, reason: "Project is locked; rebaseline to change status." });
  });

  it("explains a 403 without a body, and an unparseable 500", async () => {
    expect(await persistMove("t", "started", (async () => res(403, undefined, true)) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "You don't have permission to change this task.",
    });
    expect(await persistMove("t", "started", (async () => res(500, undefined, true)) as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "The server answered 500.",
    });
  });

  it("turns a dead network into a failure result instead of throwing", async () => {
    const out = await persistMove("t", "started", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(out).toEqual({ ok: false, reason: "The server could not be reached." });
  });
});

describe("rejectionReason", () => {
  it("prefers the API error text over the status", async () => {
    expect(await rejectionReason(res(409, { error: "Out of date" }))).toBe("Out of date");
  });
  it("ignores a non-string error field", async () => {
    expect(await rejectionReason(res(500, { error: { code: 1 } }))).toBe("The server answered 500.");
  });
  it("handles an expired session", async () => {
    expect(await rejectionReason(res(401, undefined, true))).toBe("Your session has expired.");
  });
});

describe("move states: 'audited' is never shown before the save returns", () => {
  const empty: MoveStates = new Map();

  it("a freshly dropped card is saving, not saved", () => {
    const s = withMove(empty, "t1", "saving");
    expect(s.get("t1")).toBe("saving");
    expect(s.get("t1")).not.toBe("saved");
  });

  it("moves to saved only on success, and a failure clears the card back to nothing", () => {
    const saving = withMove(empty, "t1", "saving");
    expect(withMove(saving, "t1", "saved").get("t1")).toBe("saved");
    expect(withMove(saving, "t1", null).has("t1")).toBe(false);
  });

  it("never mutates the previous map (React state stays immutable)", () => {
    const a = withMove(empty, "t1", "saving");
    const b = withMove(a, "t2", "saving");
    expect(a.has("t2")).toBe(false);
    expect(b.size).toBe(2);
  });

  it("the timed clear leaves a newer move alone", () => {
    const saved = withMove(empty, "t1", "saved");
    expect(expireSaved(saved, "t1").has("t1")).toBe(false);
    // the card was moved again meanwhile: the old timer must not wipe "saving"
    const movedAgain = withMove(saved, "t1", "saving");
    expect(expireSaved(movedAgain, "t1")).toBe(movedAgain);
  });
});

describe("failureMessage", () => {
  it("names the task, the destination, the reason and where the card went back to", () => {
    expect(
      failureMessage({ name: "Draft plan", toTitle: "Done", fromTitle: "In progress", reason: "Project is locked." }),
    ).toBe(`Couldn't move "Draft plan" to Done: Project is locked. It is back in In progress.`);
  });
});
