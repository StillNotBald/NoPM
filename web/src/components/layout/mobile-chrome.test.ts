/**
 * Guard tests for wave3-mobile / W3-T2-shell-chrome.
 *
 * Following the source-inspection pattern used elsewhere in this repo (see
 * src/app/error-boundaries.test.ts, src/lib/auth/workspace-isolation.test.ts)
 * rather than mounting React — there is no jsdom/@testing-library dependency
 * in this project (vitest.config.ts runs `environment: "node"` and only
 * globs `src/**\/*.test.ts`, not .tsx). These tests read the component
 * source and assert the Tailwind breakpoint contract holds:
 *   1. the command palette gets a reachable mobile search entry, and its
 *      dialog is full-screen below sm / pixel-identical to today at sm+.
 *   2. the toast stack clears the mobile bottom-nav + iOS safe area below
 *      lg, and is pixel-identical to today (bottom-4) at lg+.
 *   3. the header's icon buttons hit >=44px below lg while staying
 *      pixel-identical (40px) at lg+.
 * A source-text assertion can't verify real layout, but it does pin the
 * exact class tokens so a future edit can't silently drop the breakpoint
 * gate that keeps desktop pixel-identical (locked decision: "desktop
 * regression = failure").
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS_DIR = join(process.cwd(), "src", "components");
const COMMAND_PALETTE = readFileSync(join(COMPONENTS_DIR, "command-palette.tsx"), "utf8");
const APP_SHELL = readFileSync(join(COMPONENTS_DIR, "layout", "app-shell.tsx"), "utf8");
const TOAST = readFileSync(join(COMPONENTS_DIR, "ui", "toast.tsx"), "utf8");
const RIGHT_PUSH_PANEL = readFileSync(join(COMPONENTS_DIR, "ui", "right-push-panel.tsx"), "utf8");
const MODAL = readFileSync(join(COMPONENTS_DIR, "ui", "modal.tsx"), "utf8");
const FILTER_SHEET_PATH = join(COMPONENTS_DIR, "ui", "filter-sheet.tsx");
const DATA_LIST_PATH = join(COMPONENTS_DIR, "ui", "data-list.tsx");
const FILTER_SHEET = readFileSync(FILTER_SHEET_PATH, "utf8");
const DATA_LIST = readFileSync(DATA_LIST_PATH, "utf8");

/** Recursively collect every .tsx file under `dir`. */
function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...collectTsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Palette mobile entry (locked decision 2)
// ---------------------------------------------------------------------------
describe("command palette — mobile search entry", () => {
  it("keeps the existing desktop/tablet pill trigger hidden below sm, shown sm+", () => {
    expect(COMMAND_PALETTE).toMatch(/export function CmdKTrigger\(/);
    // the pill's own className block must still be gated `hidden … sm:flex`
    const pill = COMMAND_PALETTE.slice(
      COMMAND_PALETTE.indexOf("export function CmdKTrigger("),
      COMMAND_PALETTE.indexOf("export function CmdKTriggerMobile("),
    );
    expect(pill).toMatch(/"hidden items-center/);
    expect(pill).toMatch(/sm:flex/);
  });

  it("adds a complementary icon-only trigger visible only below sm, with a >=44px hit area and an aria-label", () => {
    expect(COMMAND_PALETTE).toMatch(/export function CmdKTriggerMobile\(/);
    const mobileTrigger = COMMAND_PALETTE.slice(
      COMMAND_PALETTE.indexOf("export function CmdKTriggerMobile("),
    );
    expect(mobileTrigger).toMatch(/aria-label="Search/);
    expect(mobileTrigger).toMatch(/h-11 w-11/); // 44px (2.75rem) minimum touch target
    expect(mobileTrigger).toMatch(/sm:hidden/); // exact complement of the sm:flex pill
  });

  it("is wired into app-shell.tsx's header and opens the same command palette", () => {
    expect(APP_SHELL).toMatch(/import\s*\{[^}]*CmdKTriggerMobile[^}]*\}\s*from\s*"@\/components\/command-palette"/);
    expect(APP_SHELL).toMatch(/<CmdKTriggerMobile onClick=\{openCmd\}\s*\/>/);
    // the desktop pill must still be rendered too — the mobile icon is additive
    expect(APP_SHELL).toMatch(/<CmdKTrigger onClick=\{openCmd\}\s*\/>/);
  });
});

describe("command palette — full-screen dialog below sm, centered dialog sm+", () => {
  const dialogBlock = COMMAND_PALETTE.slice(
    COMMAND_PALETTE.indexOf("export function CommandPalette("),
    COMMAND_PALETTE.indexOf("export function CmdKTrigger("),
  );

  it("fills the screen below sm (h-full w-full, no rounding/border, safe-area padding)", () => {
    expect(dialogBlock).toMatch(/h-full w-full flex-col/);
    expect(dialogBlock).toMatch(/rounded-none border-0/);
    expect(dialogBlock).toMatch(/pt-\[env\(safe-area-inset-top\)\]/);
    expect(dialogBlock).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });

  it("reverts to today's centered dialog at sm+ (pixel-identical: max-w-lg, rounded-xl, bordered, 15vh top offset)", () => {
    expect(dialogBlock).toMatch(/sm:h-auto/);
    expect(dialogBlock).toMatch(/sm:max-w-lg/);
    expect(dialogBlock).toMatch(/sm:rounded-xl/);
    expect(dialogBlock).toMatch(/sm:border sm:border-border-subtle/);
    expect(dialogBlock).toMatch(/sm:pt-0 sm:pb-0/);
    expect(dialogBlock).toMatch(/sm:items-start sm:pt-\[15vh\]/);
  });

  it("gives the results list a mobile-only close button (44px) so full-screen isn't a dead end", () => {
    const panelBlock = COMMAND_PALETTE.slice(
      COMMAND_PALETTE.indexOf("function CommandPalettePanel("),
      COMMAND_PALETTE.indexOf("export function CommandPalette("),
    );
    expect(panelBlock).toMatch(/aria-label="Close command palette"/);
    expect(panelBlock).toMatch(/h-11 w-11 shrink-0 place-items-center rounded-md text-ink-secondary hover:bg-sunken sm:hidden/);
  });
});

// ---------------------------------------------------------------------------
// 2. Toast offset (bottom-nav + safe-area clearance)
// ---------------------------------------------------------------------------
describe("toast.tsx — Toaster clears the mobile bottom nav + safe area", () => {
  // Scope to the Toaster component only — toast.tsx also has an unrelated
  // "slide-in-from-bottom-4" animation class on ToastTile that a whole-file
  // regex would false-positive on.
  const toasterBlock = TOAST.slice(
    TOAST.indexOf("function Toaster("),
    TOAST.indexOf("// ── Provider"),
  );

  it("offsets below lg using the same env(safe-area-inset-bottom) pattern as bottom-nav.tsx / right-push-panel.tsx", () => {
    expect(toasterBlock).toMatch(/bottom-\[calc\(5rem_\+_env\(safe-area-inset-bottom\)\)\]/);
  });

  it("keeps lg+ pixel-identical to the original bottom-4 anchor, gated behind lg: (not an unconditional bottom-4)", () => {
    expect(toasterBlock).toMatch(/lg:bottom-4/);
    // the anchor position class must be the calc(...) offset gated by lg:,
    // not a bare unconditional "bottom-4" — the only occurrence of the
    // literal token "bottom-4" in this block must be prefixed "lg:"
    const anchorLine = toasterBlock
      .split("\n")
      .find((l) => l.includes("pointer-events-none fixed"));
    expect(anchorLine).toBeTruthy();
    const allBottom4 = anchorLine!.match(/\bbottom-4\b/g) ?? [];
    const gatedBottom4 = anchorLine!.match(/lg:bottom-4\b/g) ?? [];
    expect(allBottom4.length).toBe(gatedBottom4.length);
    expect(allBottom4.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Touch targets — header chrome only (targeted subset, locked decision 4)
// ---------------------------------------------------------------------------
describe("app-shell.tsx — header icon buttons hit >=44px below lg, unchanged at lg+", () => {
  it("assistant (sparkles) trigger: h-11 w-11 below lg, lg:h-10 lg:w-10 (pixel-identical) at lg+", () => {
    const assistantBtn = APP_SHELL.slice(
      APP_SHELL.indexOf('aria-label="Open AI assistant"') - 400,
      APP_SHELL.indexOf('aria-label="Open AI assistant"') + 400,
    );
    expect(assistantBtn).toMatch(/h-11 w-11/);
    expect(assistantBtn).toMatch(/lg:h-10 lg:w-10/);
  });

  it("sidebar collapse toggle: bumped to h-11 w-11, restores the original lg:h-10 lg:w-10 at lg+", () => {
    const collapseBtn = APP_SHELL.slice(
      APP_SHELL.indexOf('aria-label="Collapse sidebar"') - 400,
      APP_SHELL.indexOf('aria-label="Collapse sidebar"') + 400,
    );
    expect(collapseBtn).toMatch(/h-11 w-11/);
    expect(collapseBtn).toMatch(/lg:h-10 lg:w-10/);
  });

  it("does not touch NotificationBell/ThemeToggle/AccountMenu source (not owned by this task)", () => {
    // app-shell.tsx only *renders* these; it must not inline their button markup
    expect(APP_SHELL).toMatch(/<NotificationBell \/>/);
    expect(APP_SHELL).toMatch(/<ThemeToggle \/>/);
    expect(APP_SHELL).toMatch(/<AccountMenu \/>/);
  });

  it("marks a stable data-app-shell region containing the sidebar/header/content/bottom-nav, ahead of the overlay layers (CommandPalette/RightPushPanel/AssistantPanel)", () => {
    expect(APP_SHELL).toMatch(/data-app-shell/);
    const shellStart = APP_SHELL.indexOf("data-app-shell");
    const shellEnd = APP_SHELL.indexOf("<BottomNav");
    const commandPaletteIdx = APP_SHELL.indexOf("<CommandPalette");
    const rightPushPanelIdx = APP_SHELL.indexOf("<RightPushPanel");
    // the overlay components render AFTER the data-app-shell wrapper closes,
    // i.e. they are siblings of it, not descendants
    expect(shellEnd).toBeGreaterThan(shellStart);
    expect(commandPaletteIdx).toBeGreaterThan(shellEnd);
    expect(rightPushPanelIdx).toBeGreaterThan(shellEnd);
  });
});

// ---------------------------------------------------------------------------
// 4. Mobile shell (R-94) — sheet lock/inert/focus hooks, 44px close buttons,
//    the text-2xs floor, and the FilterSheet/DataList primitives.
// ---------------------------------------------------------------------------

describe("right-push-panel.tsx / modal.tsx — shared sheet hooks", () => {
  it("both import useBodyScrollLock and useInertShell from lib/hooks/use-sheet", () => {
    for (const src of [RIGHT_PUSH_PANEL, MODAL]) {
      expect(src).toMatch(/from ["']@\/lib\/hooks\/use-sheet["']/);
      expect(src).toMatch(/useBodyScrollLock/);
      expect(src).toMatch(/useInertShell/);
    }
  });

  it("both size their close button at h-11 w-11 (44px) — was h-8 w-8 (32px)", () => {
    const panelCloseIdx = RIGHT_PUSH_PANEL.indexOf('aria-label="Close panel"');
    expect(RIGHT_PUSH_PANEL.slice(panelCloseIdx - 200, panelCloseIdx + 80)).toMatch(/h-11 w-11/);
    const modalCloseIdx = MODAL.indexOf('aria-label="Close"');
    expect(MODAL.slice(modalCloseIdx - 200, modalCloseIdx + 80)).toMatch(/h-11 w-11/);
  });

  it("right-push-panel keeps the ≥lg push-column contract unchanged (right-0, no border-t, lg width class applied)", () => {
    expect(RIGHT_PUSH_PANEL).toMatch(/lg:inset-y-0 lg:right-0/);
    expect(RIGHT_PUSH_PANEL).toMatch(/lg:rounded-none/);
  });

  it("right-push-panel renders a bottom sheet (top radius) between md and lg", () => {
    expect(RIGHT_PUSH_PANEL).toMatch(/md:rounded-t-2xl/);
  });

  it("both support an optional sticky footer slot", () => {
    expect(RIGHT_PUSH_PANEL).toMatch(/footer\?:\s*ReactNode/);
    expect(MODAL).toMatch(/footer\?:\s*ReactNode/);
  });
});

describe("no literal text-[8px]/[9px]/[10px] in components/ui or components/layout", () => {
  it("F8 — every literal tiny-text class is replaced by the text-2xs token", () => {
    const files = [
      ...collectTsxFiles(join(COMPONENTS_DIR, "ui")),
      ...collectTsxFiles(join(COMPONENTS_DIR, "layout")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/text-\[(8|9|10)px\]/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("filter-sheet.tsx — FilterSheet", () => {
  it("exists and exports the documented props", () => {
    expect(FILTER_SHEET).toMatch(/export function FilterSheet/);
    expect(FILTER_SHEET).toMatch(/activeCount/);
    expect(FILTER_SHEET).toMatch(/onApply/);
    expect(FILTER_SHEET).toMatch(/onClear/);
    expect(FILTER_SHEET).toMatch(/children/);
  });

  it("renders children inline (unchanged) at md+, and a Modal-based sheet below md", () => {
    expect(FILTER_SHEET).toMatch(/from ["']@\/lib\/hooks\/use-media-query["']/);
    expect(FILTER_SHEET).toMatch(/return <div className="contents">\{children\}<\/div>/);
    expect(FILTER_SHEET).toMatch(/from ["']@\/components\/ui\/modal["']/);
  });

  it("the mobile trigger is a 44px control with an active-count badge", () => {
    expect(FILTER_SHEET).toMatch(/h-11 w-11/);
    expect(FILTER_SHEET).toMatch(/activeCount > 0/);
  });
});

describe("data-list.tsx — DataList", () => {
  it("exists and exports the documented column/prop shape", () => {
    expect(DATA_LIST).toMatch(/export interface DataListColumn/);
    expect(DATA_LIST).toMatch(/export function DataList/);
    for (const key of ["key", "header", "cell", "primary", "badge", "hideOnMobile", "align"]) {
      expect(DATA_LIST).toMatch(new RegExp(key));
    }
    for (const prop of ["rows", "rowKey", "onRowClick", "href", "empty", "renderCard"]) {
      expect(DATA_LIST).toMatch(new RegExp(prop));
    }
  });

  it("renders a <table> gated to md+ and a card <ul> gated below md", () => {
    expect(DATA_LIST).toMatch(/hidden overflow-x-auto md:block/);
    expect(DATA_LIST).toMatch(/<table/);
    expect(DATA_LIST).toMatch(/divide-y divide-border-subtle md:hidden/);
  });

  it("shows a chevron on cards only when the row is clickable (onRowClick or href)", () => {
    expect(DATA_LIST).toMatch(/const clickable = Boolean\(onRowClick \|\| href\)/);
    expect(DATA_LIST).toMatch(/ChevronRight/);
  });
});

