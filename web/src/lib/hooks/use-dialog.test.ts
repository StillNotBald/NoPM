/**
 * Overlay behaviour added on top of use-sheet.ts: Tab trap, Escape stack,
 * opener capture / fallback focus, and the composed useDialog. There is no DOM
 * test environment in this repo (see use-sheet.test.ts), so the wrap-around
 * rule is tested as the pure function it is, and the wiring is pinned by
 * source scan.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trapTarget } from "./use-sheet";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "hooks", "use-sheet.ts"), "utf8");

describe("trapTarget — Tab wrap-around inside a focus trap", () => {
  const items = ["a", "b", "c"];

  it("lets the browser move focus when Tab is not on an edge", () => {
    expect(trapTarget(items, "a", false)).toBeNull();
    expect(trapTarget(items, "b", false)).toBeNull();
    expect(trapTarget(items, "b", true)).toBeNull();
    expect(trapTarget(items, "c", true)).toBeNull();
  });

  it("wraps Tab from the last item to the first, and Shift+Tab from the first to the last", () => {
    expect(trapTarget(items, "c", false)).toBe("a");
    expect(trapTarget(items, "a", true)).toBe("c");
  });

  it("pulls focus in when it is outside the trap or on the container itself", () => {
    expect(trapTarget(items, null, false)).toBe("a");
    expect(trapTarget(items, null, true)).toBe("c");
    expect(trapTarget(items, "outside", false)).toBe("a");
    expect(trapTarget(items, "outside", true)).toBe("c");
  });

  it("a single tabbable traps both directions on itself", () => {
    expect(trapTarget(["only"], "only", false)).toBe("only");
    expect(trapTarget(["only"], "only", true)).toBe("only");
  });

  it("with nothing tabbable, keeps focus on the fallback container", () => {
    expect(trapTarget([], null, false, "container")).toBe("container");
    expect(trapTarget([], "x", true, "container")).toBe("container");
    expect(trapTarget([], null, false)).toBeNull();
  });
});

describe("use-sheet.ts — Escape stack", () => {
  it("exports useEscapeClose and registers ONE document listener for every overlay", () => {
    expect(SOURCE).toMatch(/export function useEscapeClose\(open: boolean, onClose: \(\) => void\)/);
    expect(SOURCE).toMatch(/const escapeStack: EscapeEntry\[\] = \[\];/);
    // only the top of the stack is closed per keypress
    expect(SOURCE).toMatch(/const top = escapeStack\[escapeStack\.length - 1\];/);
    expect(SOURCE).toMatch(/top\.close\(\);/);
    expect(SOURCE.match(/document\.addEventListener\("keydown", onEscapeKeyDown\)/g)).toHaveLength(1);
  });

  it("ignores Escape while an IME composition is active", () => {
    expect(SOURCE).toMatch(/e\.isComposing/);
  });

  it("removes the listener when the last overlay closes", () => {
    expect(SOURCE).toMatch(/escapeStack\.length === 0 && escapeListening/);
    expect(SOURCE).toMatch(/document\.removeEventListener\("keydown", onEscapeKeyDown\)/);
  });
});

describe("use-sheet.ts — focus trap and focus return", () => {
  it("only the top-most trap acts, and it listens in the capture phase", () => {
    expect(SOURCE).toMatch(/export function useFocusTrap\(containerRef: RefObject<HTMLElement \| null>, active: boolean\)/);
    expect(SOURCE).toMatch(/trapStack\[trapStack\.length - 1\] !== token/);
    expect(SOURCE).toMatch(/document\.addEventListener\("keydown", onKeyDown, true\)/);
  });

  it("skips inert, display:none and visibility:hidden elements when collecting tabbables", () => {
    expect(SOURCE).toMatch(/closest\("\[inert\]"\)/);
    expect(SOURCE).toMatch(/getClientRects\(\)\.length > 0/);
    expect(SOURCE).toMatch(/visibility !== "hidden"/);
  });

  it("captures the opener in a LAYOUT effect (before any child's autofocus effect)", () => {
    const hook = SOURCE.slice(SOURCE.indexOf("export function useReturnFocus"), SOURCE.indexOf("// ── useEscapeClose"));
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(open\) \{[\s\S]*?openerRef\.current =/);
    // <body> counts as "nothing focused": no opener, so close falls back to <main>
    expect(hook).toMatch(/active !== document\.body/);
  });

  it("falls back to <main> when the opener is gone, and never on first mount", () => {
    expect(SOURCE).toMatch(/export const MAIN_CONTENT_ID = "main-content"/);
    expect(SOURCE).toMatch(/document\.getElementById\(MAIN_CONTENT_ID\)\?\.focus\(\)/);
    // an opener that refuses focus (hidden, disabled) also falls through to <main>
    expect(SOURCE).toMatch(/if \(document\.activeElement === opener\) return;/);
    expect(SOURCE).toMatch(/if \(!wasOpenRef\.current\) return;/);
  });

  it("useDialog composes escape + trap + return-focus, and lock/inert only for sheets", () => {
    const hook = SOURCE.slice(SOURCE.indexOf("export function useDialog"));
    expect(hook).toMatch(/useBodyScrollLock\(open && sheet\)/);
    expect(hook).toMatch(/useInertShell\(open && sheet\)/);
    expect(hook).toMatch(/useEscapeClose\(open, onClose\)/);
    expect(hook).toMatch(/useFocusTrap\(containerRef, open && trap\)/);
    expect(hook).toMatch(/useReturnFocus\(open, initialFocusRef \?\? containerRef, openerRef\)/);
  });
});
