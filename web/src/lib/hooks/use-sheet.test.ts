/**
 * use-sheet.ts touches document/window and has no jsdom available in this
 * repo (see use-media-query.test.ts's header for why) — so this is a
 * source-scan pinning the two structural guarantees that matter most:
 * the `<lg` gate (desktop RightPushPanel must stay a non-modal push-column,
 * unlocked/non-inert) and reference counting (nested sheets must not undo
 * the lock/inert state until the LAST one closes).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "hooks", "use-sheet.ts"), "utf8");

describe("use-sheet.ts — exports", () => {
  it("exports useBodyScrollLock, useInertShell, and useReturnFocus", () => {
    expect(SOURCE).toMatch(/export function useBodyScrollLock\(open: boolean\)/);
    expect(SOURCE).toMatch(/export function useInertShell\(open: boolean\)/);
    expect(SOURCE).toMatch(/export function useReturnFocus\(/);
  });
});

describe("use-sheet.ts — <lg gate (≥lg push-column must stay unlocked/non-inert)", () => {
  it("both useBodyScrollLock and useInertShell bail out via isBelowLg() before doing anything", () => {
    const lockBody = SOURCE.slice(
      SOURCE.indexOf("export function useBodyScrollLock"),
      SOURCE.indexOf("// ── useInertShell"),
    );
    const inertBody = SOURCE.slice(
      SOURCE.indexOf("export function useInertShell"),
      SOURCE.indexOf("// ── useReturnFocus"),
    );
    expect(lockBody).toMatch(/if \(!open \|\| !isBelowLg\(\)\) return;/);
    expect(inertBody).toMatch(/if \(!open \|\| !isBelowLg\(\)\) return;/);
  });

  it("isBelowLg matches the same 1024px boundary QUERY_LG_UP uses", () => {
    expect(SOURCE).toMatch(/matchMedia\("\(min-width: 1024px\)"\)/);
  });
});

describe("use-sheet.ts — reference counting for nested sheets", () => {
  it("scroll lock only restores body styles when the counter reaches zero", () => {
    expect(SOURCE).toMatch(/let scrollLockCount = 0;/);
    expect(SOURCE).toMatch(/scrollLockCount \+= 1;/);
    expect(SOURCE).toMatch(/scrollLockCount = Math\.max\(0, scrollLockCount - 1\);/);
    expect(SOURCE).toMatch(/if \(scrollLockCount === 0\) \{/);
  });

  it("inert only clears from the shell when the counter reaches zero", () => {
    expect(SOURCE).toMatch(/let inertCount = 0;/);
    expect(SOURCE).toMatch(/inertCount \+= 1;/);
    expect(SOURCE).toMatch(/inertCount = Math\.max\(0, inertCount - 1\);/);
    expect(SOURCE).toMatch(/if \(inertCount === 0\) \{/);
  });

  it("targets the stable [data-app-shell] region", () => {
    expect(SOURCE).toMatch(/querySelector<HTMLElement>\("\[data-app-shell\]"\)/);
  });
});
