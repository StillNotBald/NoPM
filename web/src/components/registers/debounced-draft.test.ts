/**
 * Typing into a URL-bound search box must never lose a character.
 *
 * The defect (UI audit A3): the input was bound straight to the URL, every
 * keystroke was a router.push, and the late echo of an older URL overwrote what
 * the user had typed since — "run stakeholder" became "ru tder" at 120 ms/char.
 * These tests drive the draft controller the FilterBar uses with a fake router
 * whose URL lags the write, and assert the draft only ever moves forward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftSync, type DraftSync } from "./debounced-draft";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A controller wired to a fake router: each commit "lands" in the URL after `lagMs`. */
function harness({ external = "", delayMs = 300, lagMs = 150 } = {}) {
  const commits: string[] = [];
  const draftsSeen: string[] = [];
  let url = external;
  const sync: DraftSync = createDraftSync({
    external,
    delayMs,
    commit: (value) => {
      commits.push(value);
      setTimeout(() => {
        url = value;
        sync.receive(url);
      }, lagMs);
    },
    onDraft: (value) => draftsSeen.push(value),
  });
  return {
    sync,
    commits,
    draftsSeen,
    get url() {
      return url;
    },
    /** Type `text` one character at a time, asserting the draft never loses a character. */
    typeSlowly(text: string, perCharMs: number) {
      const typed: string[] = [];
      for (const ch of text) {
        const next = (typed.at(-1) ?? "") + ch;
        typed.push(next);
        sync.type(next);
        expect(sync.draft).toBe(next);
        vi.advanceTimersByTime(perCharMs);
        // An older URL echo may land mid-typing; the user's text must survive it.
        expect(sync.draft).toBe(next);
      }
    },
  };
}

describe("typing into a URL-bound search box", () => {
  it.each([
    { perCharMs: 60, lagMs: 150 },
    { perCharMs: 120, lagMs: 400 },
    { perCharMs: 200, lagMs: 250 },
    { perCharMs: 350, lagMs: 900 },
  ])("keeps every character at $perCharMs ms/char with a $lagMs ms router lag", ({ perCharMs, lagMs }) => {
    const h = harness({ lagMs });
    const phrase = "run stakeholder";
    h.typeSlowly(phrase, perCharMs);
    expect(h.sync.draft).toBe(phrase);

    vi.advanceTimersByTime(5000); // let the last commit and its echo land
    expect(h.sync.draft).toBe(phrase);
    expect(h.url).toBe(phrase);
    expect(h.commits.at(-1)).toBe(phrase);
  });

  it("debounces: a burst of keystrokes is one URL write, not one per character", () => {
    const h = harness();
    h.typeSlowly("stakeholder", 60);
    vi.advanceTimersByTime(5000);
    expect(h.commits).toEqual(["stakeholder"]);
  });

  it("survives echoes of earlier writes landing long after newer typing (every keystroke commits, the router lags five behind)", () => {
    const h = harness({ delayMs: 100, lagMs: 700 });
    h.typeSlowly("run stakeholder", 150);
    vi.advanceTimersByTime(10_000);
    expect(h.sync.draft).toBe("run stakeholder");
    expect(h.url).toBe("run stakeholder");
  });

  it("does not write a value the URL already holds", () => {
    const h = harness({ external: "risk" });
    h.sync.type("riskx");
    h.sync.type("risk"); // back to what the URL says before the pause elapses
    vi.advanceTimersByTime(5000);
    expect(h.commits).toEqual([]);
  });

  it("flush() writes immediately (Enter / blur) and does not write again when the timer would have fired", () => {
    const h = harness();
    h.sync.type("budget");
    h.sync.flush();
    expect(h.commits).toEqual(["budget"]);
    vi.advanceTimersByTime(5000);
    expect(h.commits).toEqual(["budget"]);
  });

  it("flush() with nothing pending is a no-op", () => {
    const h = harness();
    h.sync.flush();
    expect(h.commits).toEqual([]);
  });
});

describe("changes that did not come from this input", () => {
  it("adopts Clear filters: the settled URL value going blank empties the draft", () => {
    const h = harness();
    h.typeSlowly("abc", 100);
    vi.advanceTimersByTime(5000);
    expect(h.sync.draft).toBe("abc");

    h.sync.receive("");
    expect(h.sync.draft).toBe("");
    expect(h.draftsSeen.at(-1)).toBe("");
  });

  it("adopts Back/Forward and saved views, and drops a pending write for the value they replaced", () => {
    const h = harness();
    h.sync.type("abc"); // pending, not yet committed
    h.sync.receive("zzz"); // browser Back to ?q=zzz
    expect(h.sync.draft).toBe("zzz");
    vi.advanceTimersByTime(5000);
    expect(h.commits).toEqual([]);
  });

  it("a value committed earlier in the session is not mistaken for our own echo once it has settled", () => {
    const h = harness();
    h.sync.type("a");
    vi.advanceTimersByTime(5000); // "a" committed + echoed
    h.sync.type("");
    vi.advanceTimersByTime(5000); // "" committed + echoed
    h.sync.type("xyz");
    vi.advanceTimersByTime(5000); // "xyz" committed + echoed

    h.sync.receive(""); // Clear filters -> ?q removed
    expect(h.sync.draft).toBe("");
  });

  it("when the router skips intermediate URLs, only the last write's echo is needed", () => {
    const commits: string[] = [];
    const sync = createDraftSync({
      external: "",
      delayMs: 10,
      commit: (v) => commits.push(v),
      onDraft: () => {},
    });
    sync.type("a");
    vi.advanceTimersByTime(20);
    sync.type("ab");
    vi.advanceTimersByTime(20);
    expect(commits).toEqual(["a", "ab"]);

    sync.receive("ab"); // "a" was never rendered
    sync.type("abc");
    expect(sync.draft).toBe("abc");
    sync.receive(""); // a genuine external clear still gets through
    expect(sync.draft).toBe("");
  });

  it("dispose() cancels a pending write", () => {
    const h = harness();
    h.sync.type("pending");
    h.sync.dispose();
    vi.advanceTimersByTime(5000);
    expect(h.commits).toEqual([]);
  });
});
