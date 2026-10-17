/**
 * Control changes build on what the toolbar last WROTE to the URL, not what the
 * router last rendered. Otherwise a debounced search commit that fires while a
 * select change is still navigating is built from the stale params and silently
 * drops that select (the user sees a filter they just picked revert).
 */
import { describe, expect, it } from "vitest";
import {
  PENDING_WINDOW_MS,
  applyControlsUpdate,
  baseQueryString,
  recordWrite,
  settleWrites,
  type PendingWrites,
} from "./use-list-controls";

const T0 = 1_000_000;

function commitText(base: string, value: string): string {
  return applyControlsUpdate(new URLSearchParams(base), { q: value }).toString();
}

describe("a text commit while a select change is still navigating", () => {
  it("keeps the select (built on the pending write, not the stale rendered URL)", () => {
    const rendered = ""; // the router has not rendered the select change yet
    const afterSelect = recordWrite(null, "status=open", T0);

    const base = baseQueryString(afterSelect, rendered, T0 + 200);
    expect(commitText(base, "run")).toBe("status=open&q=run");

    // built from the rendered params instead, the select would be gone:
    expect(commitText(rendered, "run")).toBe("q=run");
  });

  it("stacks successive writes, newest wins as the base", () => {
    let pending = recordWrite(null, "status=open", T0);
    pending = recordWrite(pending, "status=open&q=run", T0 + 300);
    expect(pending.qs).toEqual(["status=open", "status=open&q=run"]);
    expect(baseQueryString(pending, "", T0 + 400)).toBe("status=open&q=run");
  });
});

describe("settling pending writes against what the router rendered", () => {
  const pending: PendingWrites = { qs: ["a=1", "a=1&b=2"], at: T0 };

  it("drops everything up to the echoed write and keeps the rest in flight", () => {
    expect(settleWrites(pending, "a=1")).toEqual({ qs: ["a=1&b=2"], at: T0 });
  });

  it("clears once the newest write has landed", () => {
    expect(settleWrites(pending, "a=1&b=2")).toBeNull();
  });

  it("an unrelated render (Back/Forward, a link) supersedes the pending writes", () => {
    expect(settleWrites(pending, "c=3")).toBeNull();
  });

  it("is a no-op with nothing pending", () => {
    expect(settleWrites(null, "a=1")).toBeNull();
  });
});

describe("base query string", () => {
  it("falls back to the rendered params when nothing is pending", () => {
    expect(baseQueryString(null, "status=open", T0)).toBe("status=open");
  });

  it("stops trusting a write that never landed (cancelled navigation) after the window", () => {
    const stale = recordWrite(null, "status=closed", T0);
    expect(baseQueryString(stale, "status=open", T0 + PENDING_WINDOW_MS - 1)).toBe("status=closed");
    expect(baseQueryString(stale, "status=open", T0 + PENDING_WINDOW_MS)).toBe("status=open");
  });
});
