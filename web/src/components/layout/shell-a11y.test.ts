/**
 * Shell + overlay accessibility contracts (UI audit A1). Mixed on purpose:
 * where a component can be server-rendered the markup is asserted directly
 * (command palette semantics, bell trigger); where behaviour needs a browser
 * (Portal, inert, focus) the wiring is pinned by source scan, because the repo
 * has no DOM test environment.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/tasks",
}));
vi.mock("@/components/forms/project-form", () => ({ ProjectForm: () => null }));
vi.mock("@/lib/api-client", () => ({ apiGet: async () => ({}), apiPatch: async () => ({}), apiPost: async () => ({}) }));

import { CommandPalette, CmdKTrigger, CmdKTriggerMobile } from "@/components/command-palette";
import { NotificationBell } from "@/components/notifications/bell";
import { ALL_NAV_ITEMS, EXTRA_NAV_ITEMS } from "@/lib/nav/nav-config";
import { isActiveRoute } from "./active-route";
import { shortcutGroups } from "./keyboard-shortcuts";
import { detectMac, modKeyLabel } from "./use-is-mac";

const SRC = join(process.cwd(), "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

const SHELL_FILES = [
  ...tsxFiles(join(SRC, "components", "layout")),
  ...tsxFiles(join(SRC, "components", "ui")),
  ...tsxFiles(join(SRC, "components", "notifications")),
  join(SRC, "components", "command-palette.tsx"),
  join(SRC, "components", "assistant", "panel.tsx"),
];

// ── command palette: combobox + listbox ─────────────────────────────────────

describe("command palette — combobox / listbox semantics", () => {
  const markup = renderToStaticMarkup(createElement(CommandPalette, { open: true, onOpenChange: () => {} }));

  it("is a labelled modal dialog", () => {
    expect(markup).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Command palette"/);
  });

  it("the search input is a labelled combobox that controls the listbox and tracks the active option", () => {
    const input = /<input[^>]*>/.exec(markup)?.[0] ?? "";
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-label="Search commands and records"');
    expect(input).toContain('aria-autocomplete="list"');
    const controls = /aria-controls="([^"]+)"/.exec(input)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`role="listbox" id="${controls}"`);
    expect(input).toContain(`aria-activedescendant="${controls}-opt-0"`);
  });

  it("every result is an option out of the tab order; exactly the first is selected", () => {
    const options = [...markup.matchAll(/<button[^>]*role="option"[^>]*>/g)].map((m) => m[0]);
    // New Project + every nav destination (sidebar list plus the extras)
    expect(options).toHaveLength(1 + ALL_NAV_ITEMS.length + EXTRA_NAV_ITEMS.length);
    for (const o of options) expect(o).toContain('tabindex="-1"');
    expect(options.filter((o) => o.includes('aria-selected="true"'))).toHaveLength(1);
    expect(options[0]).toContain('aria-selected="true"');
    const ids = options.map((o) => /\sid="([^"]+)"/.exec(o)?.[1]);
    expect(new Set(ids).size).toBe(options.length);
  });

  it("groups its results and announces the result count through a polite live region", () => {
    expect(markup).toContain('role="group" aria-label="Commands"');
    expect(markup).toMatch(/<div role="status" aria-live="polite" class="sr-only">/);
  });

  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(createElement(CommandPalette, { open: false, onOpenChange: () => {} }))).toBe("");
  });

  it("source: Escape is owned by the dialog stack (no second handler), failed searches are not 'no match'", () => {
    const src = read("components", "command-palette.tsx");
    expect(src).toMatch(/useDialog\(\{/);
    expect(src).not.toMatch(/e\.key === "Escape"/);
    expect(src).toMatch(/if \(!res\.ok\) throw/);
    expect(src).toMatch(/Search unavailable/);
    // the combobox owns focus: it autofocuses via the dialog hook, not a child mount effect
    expect(src).toMatch(/initialFocusRef: inputRef/);
    expect(src).not.toMatch(/\.scrollIntoView\(/);
  });

  it("triggers: platform-aware label, icon trigger is an IconButton", () => {
    expect(renderToStaticMarkup(createElement(CmdKTrigger, { onClick: () => {} }))).toContain('aria-label="Open command palette (Ctrl+K)"');
    const mobile = renderToStaticMarkup(createElement(CmdKTriggerMobile, { onClick: () => {} }));
    expect(mobile).toContain('aria-label="Search"');
    expect(mobile).toContain("sm:hidden");
  });
});

// ── notification bell ───────────────────────────────────────────────────────

describe("notification bell", () => {
  const markup = renderToStaticMarkup(createElement(NotificationBell));

  it("closed trigger advertises a dialog and is not expanded", () => {
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("aria-controls");
    expect(markup).toContain('aria-label="Notifications"');
  });

  it("source: the phone sheet is portaled out of the header and the desktop popover is non-modal", () => {
    const src = read("components", "notifications", "bell.tsx");
    expect(src).toMatch(/import \{ Portal \} from "@\/components\/ui\/portal"/);
    const sheet = src.slice(src.indexOf("Mobile / tablet bottom sheet"));
    expect(sheet).toMatch(/<Portal>[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*<\/Portal>/);
    const popover = src.slice(src.indexOf("Desktop popover"), src.indexOf("Mobile / tablet bottom sheet"));
    expect(popover).toMatch(/aria-modal="false"/);
    // one tray at a time, not both mounted with one display:none
    expect(src).toMatch(/const sheetOpen = open && !isDesktop;/);
    expect(src).toMatch(/const popoverOpen = open && isDesktop;/);
  });
});

// ── shell structure ─────────────────────────────────────────────────────────

describe("app shell structure", () => {
  const shell = read("components", "layout", "app-shell.tsx");

  it("header is a solid surface: backdrop-filter would capture every fixed descendant", () => {
    const header = shell.slice(shell.indexOf("<header data-shell-chrome"), shell.indexOf("<header data-shell-chrome") + 260);
    expect(header).not.toMatch(/backdrop-/);
    expect(header).toMatch(/bg-canvas px-3/);
  });

  it("has a skip link as the first focusable thing in the shell, targeting <main id tabIndex=-1>", () => {
    const appShell = shell.indexOf("<div data-app-shell");
    const skip = shell.indexOf("Skip to content");
    const sidebar = shell.indexOf("{/* sidebar");
    expect(skip).toBeGreaterThan(appShell);
    expect(skip).toBeLessThan(sidebar);
    expect(shell).toMatch(/href=\{`#\$\{MAIN_CONTENT_ID\}`\}/);
    expect(shell).toMatch(/<main\s+id=\{MAIN_CONTENT_ID\}\s+tabIndex=\{-1\}/);
    expect(read("lib", "hooks", "use-sheet.ts")).toMatch(/export const MAIN_CONTENT_ID = "main-content"/);
  });

  it("context values handed to ~80 consumers are memoised", () => {
    expect(shell).toMatch(/const inspectorApi = useMemo\(/);
    expect(shell).toMatch(/<InspectorCtx\.Provider value=\{inspectorApi\}>/);
    expect(read("components", "ui", "modal.tsx")).toMatch(/const api = useMemo\(\(\) => \(\{ open, close \}\), \[open, close\]\)/);
    expect(read("components", "ui", "toast.tsx")).toMatch(/const api = useMemo<ToastAPI>\(/);
  });

  it("sidebar: the nav link is hoisted to module scope (an inner component remounts the list and drops focus)", () => {
    const side = read("components", "layout", "sidebar.tsx");
    expect(side).toMatch(/^function SidebarItem\(/m);
    expect(side).not.toMatch(/const Item = \(/);
    expect(side).toMatch(/isActiveRoute\(n\.href, pathname\)/);
    expect(side).toMatch(/<nav aria-label="Primary"/);
  });

  it("overlays opened from inside the shell render through <Portal>, outside [data-app-shell]", () => {
    for (const f of [
      ["components", "layout", "bottom-nav.tsx"],
      ["components", "layout", "keyboard-shortcuts.tsx"],
      ["components", "notifications", "bell.tsx"],
    ]) {
      const src = read(...f);
      expect(src, f.join("/")).toMatch(/from "@\/components\/ui\/portal"/);
      expect(src, f.join("/")).toMatch(/<Portal>/);
    }
  });

  it("the Apps sheet is a real modal dialog with an accessible name, focus management and a 44px close", () => {
    const nav = read("components", "layout", "bottom-nav.tsx");
    expect(nav).toMatch(/role="dialog"\s+aria-modal="true"\s+aria-label="All apps"/);
    expect(nav).toMatch(/useDialog\(\{[\s\S]*initialFocusRef: closeBtnRef[\s\S]*openerRef: appsBtnRef[\s\S]*sheet: true/);
    expect(nav).toMatch(/aria-haspopup="dialog"/);
    expect(nav).toMatch(/grid h-11 w-11 place-items-center/);
  });

  it("bottom-nav 'Done' uses accent-ink, not white (1.8:1 in dark mode)", () => {
    expect(read("components", "layout", "bottom-nav.tsx")).toMatch(/editing \? "bg-accent text-accent-ink"/);
  });

  it("the account menu is an APG menu: roving arrows, first-item focus, Escape returns to the trigger", () => {
    const menu = read("components", "layout", "account-menu.tsx");
    expect(menu).toMatch(/aria-haspopup="menu"/);
    expect(menu).toMatch(/e\.key === "ArrowDown"/);
    expect(menu).toMatch(/e\.key === "Home"/);
    expect(menu).toMatch(/useEscapeClose\(open,/);
    expect(menu).toMatch(/role="menuitem"\s+tabIndex=\{-1\}/);
  });

  it("the project switcher is a labelled, Escape-closable disclosure that reports load failures", () => {
    const sw = read("components", "layout", "project-switcher.tsx");
    expect(sw).toMatch(/aria-expanded=\{open\}/);
    expect(sw).toMatch(/aria-label="Search projects"/);
    expect(sw).toMatch(/useEscapeClose\(open,/);
    expect(sw).toMatch(/Couldn&apos;t load projects/);
  });

  it("breadcrumbs are an ordered list and mark the current page", () => {
    const crumbs = read("components", "layout", "breadcrumbs.tsx");
    expect(crumbs).toMatch(/<ol /);
    expect(crumbs).toMatch(/aria-current=\{isLast \? "page" : undefined\}/);
    expect(crumbs).not.toMatch(/backdrop-/);
  });
});

// ── closed panels ───────────────────────────────────────────────────────────

describe("closed off-canvas panels are not reachable", () => {
  it("the assistant panel is inert + invisible while closed, keeping aria-hidden for the e2e signal", () => {
    const panel = read("components", "assistant", "panel.tsx");
    expect(panel).toMatch(/aria-hidden=\{!open\}\s+inert=\{!open\}/);
    expect(panel).toMatch(/"invisible translate-x-full pointer-events-none/);
    expect(panel).not.toMatch(/shadow-2xl/);
    expect(panel).toMatch(/useEscapeClose\(open,/);
  });

  it("panels slide the `translate` property (Tailwind v4 translate-*), not `transform`", () => {
    for (const f of [
      ["components", "ui", "right-push-panel.tsx"],
      ["components", "assistant", "panel.tsx"],
    ]) {
      expect(read(...f), f.join("/")).toMatch(/\[transition-property:translate,visibility\]/);
    }
  });
});

// ── global rules ────────────────────────────────────────────────────────────

describe("shell source hygiene", () => {
  it("no backdrop-blur in shell chrome, sheets or the palette (DESIGN.md: no blur)", () => {
    const offenders = SHELL_FILES.filter((f) => /\bbackdrop-blur/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no focus:outline-none + ring pairs (one focus-ring strength everywhere)", () => {
    // The assistant panel's chat body is another worker's surface; only its open/close chrome is covered here.
    const offenders = SHELL_FILES.filter((f) => !f.endsWith(join("assistant", "panel.tsx"))).filter((f) => /focus(-visible)?:outline-none[^"'`]*focus-visible:ring/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("never white text on an accent fill in one class string", () => {
    const offenders = SHELL_FILES.filter((f) =>
      /["'`][^"'`]*\bbg-accent\b(?![-/])[^"'`]*\btext-white\b[^"'`]*["'`]|["'`][^"'`]*\btext-white\b[^"'`]*\bbg-accent\b(?![-/])[^"'`]*["'`]/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("status text uses -ink tokens (no raw text-danger / text-warning / text-success / text-sev-high)", () => {
    const offenders = SHELL_FILES.filter((f) => /\btext-(danger|warning|success|sev-high|change|info)(?![-\w])/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("globals.css: border-color rule is layered, text-2xs is 11px at every width, reduced motion settles transitions", () => {
    const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
    expect(css).toMatch(/@layer base \{\s*\*\s*\{\s*border-color: var\(--border-subtle\);\s*\}\s*\}/);
    expect(css).not.toMatch(/^\*\s*\{\s*border-color/m);
    expect(css).toMatch(/@utility text-2xs \{\s*font-size: 11px;/);
    expect(css).not.toMatch(/\.text-2xs\s*\{\s*font-size: 10px/);
    expect(css).toMatch(/@utility focus-ring-inset/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition-duration: 0\.01ms !important/);
  });
});

// ── shortcuts dialog tells the truth ────────────────────────────────────────

describe("keyboard shortcuts dialog", () => {
  const rows = shortcutGroups("Ctrl").flatMap((g) => g.rows);
  const keys = rows.map((r) => r.keys.join("+"));

  it("lists only shortcuts that exist: Cmd/Ctrl+K, the palette's arrows and Enter, Escape", () => {
    expect(keys).toEqual(["Ctrl+K", "↑+↓", "↵", "Esc"]);
  });

  it("does not advertise the removed Mod+1/2/3 or Mod+/ bindings", () => {
    for (const k of keys) expect(k).not.toMatch(/[123/]/);
  });

  it("every listed binding has a handler", () => {
    const palette = read("components", "command-palette.tsx");
    expect(palette).toMatch(/\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "k"/);
    expect(palette).toMatch(/e\.key === "ArrowDown"/);
    expect(palette).toMatch(/e\.key === "ArrowUp"/);
    expect(palette).toMatch(/e\.key === "Enter"/);
    expect(read("lib", "hooks", "use-sheet.ts")).toMatch(/e\.key !== "Escape"/);
  });

  it("source: portaled, labelled, trapped, with a 44px close on phones and focus returned to the menu trigger", () => {
    const src = read("components", "layout", "keyboard-shortcuts.tsx");
    expect(src).toMatch(/<Portal>/);
    expect(src).toMatch(/aria-labelledby=\{titleId\}/);
    expect(src).toMatch(/useDialog\(\{[^}]*initialFocusRef: closeRef[^}]*openerRef: returnFocusRef/);
    expect(src).toMatch(/h-11 w-11[^"]*sm:h-8 sm:w-8/);
    expect(read("components", "layout", "account-menu.tsx")).toMatch(/returnFocusRef=\{triggerRef\}/);
  });

  it("labels the command key per platform", () => {
    expect(modKeyLabel(true)).toBe("⌘");
    expect(modKeyLabel(false)).toBe("Ctrl");
    expect(detectMac("MacIntel")).toBe(true);
    expect(detectMac("iPhone")).toBe(true);
    expect(detectMac("Win32")).toBe(false);
    expect(detectMac("Linux x86_64")).toBe(false);
  });
});

// ── active route rule ───────────────────────────────────────────────────────

describe("isActiveRoute", () => {
  it("matches the route and its children, never a sibling that shares a prefix", () => {
    expect(isActiveRoute("/tasks", "/tasks")).toBe(true);
    expect(isActiveRoute("/tasks", "/tasks/123")).toBe(true);
    expect(isActiveRoute("/tasks", "/tasks-archive")).toBe(false);
    expect(isActiveRoute("/tasks", "/projects/tasks")).toBe(false);
    expect(isActiveRoute("/tasks", null)).toBe(false);
    expect(isActiveRoute("/tasks", undefined)).toBe(false);
  });
});

// ── toast + modal behaviour ─────────────────────────────────────────────────

describe("toast timing and announcement (source)", () => {
  const toast = read("components", "ui", "toast.tsx");

  it("errors stay up longer than confirmations, and any caller duration still wins", () => {
    expect(toast).toMatch(/const ERROR_DURATION = 8000;/);
    expect(toast).toMatch(/opts\?\.duration \?\? \(variant === "error" \? ERROR_DURATION : DEFAULT_DURATION\)/);
  });

  it("the timer pauses on hover and focus", () => {
    for (const handler of ["onMouseEnter", "onMouseLeave", "onFocus", "onBlur"]) {
      expect(toast).toContain(`${handler}={() => setPaused(`);
    }
  });

  it("tiles are not live regions themselves (the persistent regions announce, tiles would double up)", () => {
    const tile = toast.slice(toast.indexOf("function ToastTile("), toast.indexOf("// ── Toaster stack"));
    expect(tile).not.toMatch(/role="status"/);
    expect(tile).not.toMatch(/aria-live/);
  });

  it("dismiss target is 44px on phones", () => {
    expect(toast).toMatch(/h-11 w-11[^"]*sm:h-8 sm:w-8/);
  });
});

describe("modal host (source)", () => {
  const modal = read("components", "ui", "modal.tsx");

  it("traps focus at every width and routes Escape through the overlay stack", () => {
    expect(modal).toMatch(/useFocusTrap\(dialogRef, isOpen\)/);
    expect(modal).toMatch(/useEscapeClose\(isOpen, close\)/);
  });

  it("never renders an empty heading: titled dialogs use aria-labelledby, untitled ones an aria-label", () => {
    expect(modal).toMatch(/aria-labelledby=\{title \? titleId : undefined\}/);
    expect(modal).toMatch(/aria-label=\{title \? undefined : "Dialog"\}/);
    expect(modal).not.toMatch(/\{top\.opts\.title \?\? ""\}/);
  });

  it("scrim is flat (no blur) and the card uses the 14px xl radius", () => {
    expect(modal).not.toMatch(/backdrop-blur/);
    expect(modal).toMatch(/rounded-t-xl/);
  });
});
