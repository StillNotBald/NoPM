/**
 * The numbered chat menu and the pure input parser (ADR 0020).
 *
 * Commands are digits (`/1` ... `/6`, `/0`) because Telegram command names allow
 * only a-z, 0-9 and `_`. Hidden words (`tasks`, `add`, ...) work when typed on
 * their own, never inside a longer or multi-line message. The registered menu is
 * role aware, but the backend always re-checks the role: a command typed by hand
 * is verified like a tapped one.
 */

import { normalizeLinkCode } from "@/lib/integrations/identity";
import type { BotCommand } from "./http";

export type Role = "admin" | "manager" | "member" | "viewer";

export function toRole(raw: string | null | undefined): Role {
  return raw === "admin" || raw === "manager" || raw === "viewer" ? raw : "member";
}

export type MenuN = "1" | "2" | "3" | "4" | "5" | "6";

export type MenuItem = {
  n: MenuN;
  name: string;
  blurb: string;
  /** Roles that see it in the menu (and may use it). */
  roles: readonly Role[];
  /** Words that act as this command when typed alone. */
  words: readonly string[];
};

const ALL: readonly Role[] = ["admin", "manager", "member", "viewer"];
const WRITERS: readonly Role[] = ["admin", "manager", "member"];

export const MENU: readonly MenuItem[] = [
  { n: "1", name: "My work", blurb: "Your open tasks, overdue first", roles: ALL, words: ["tasks", "my work", "work", "mine"] },
  { n: "2", name: "Add", blurb: "Add a task, issue or risk", roles: WRITERS, words: ["add", "new"] },
  { n: "3", name: "Update task", blurb: "Change a task's status or request its deletion", roles: WRITERS, words: ["update", "task"] },
  { n: "4", name: "Approvals", blurb: "Decide requests waiting on you", roles: ["admin", "manager"], words: ["approvals", "approve", "pending"] },
  { n: "5", name: "Project status", blurb: "Health of your projects (/5 name for one)", roles: ALL, words: ["status", "projects"] },
  { n: "6", name: "Digest", blurb: "A short summary now", roles: ALL, words: ["digest", "summary"] },
];

export function menuFor(role: Role): MenuItem[] {
  return MENU.filter((m) => m.roles.includes(role));
}

export function canUse(role: Role, n: MenuN): boolean {
  return MENU.find((m) => m.n === n)?.roles.includes(role) ?? false;
}

/** Entries for `setMyCommands` (command names are the digits). Includes /0 help. */
export function commandList(role: Role): BotCommand[] {
  return [...menuFor(role).map((m) => ({ command: m.n, description: m.name })), { command: "0", description: "Help and menu" }];
}

/** True when the role's registered menu differs from the default (member) one. */
export function menuDiffersFromDefault(role: Role): boolean {
  return JSON.stringify(commandList(role)) !== JSON.stringify(commandList("member"));
}

export type Input =
  | { kind: "start"; code: string | null }
  | { kind: "link"; code: string }
  | { kind: "help"; all: boolean }
  | { kind: "menu"; n: MenuN; arg: string }
  | { kind: "cancel" }
  | { kind: "text"; text: string };

const CANCEL_WORDS = new Set(["cancel", "stop", "exit", "quit", "abort"]);

/** NFKC, strip zero-width and control characters (newline and tab stay), trim. */
export function normalise(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();
}

const WORD_TO_N = new Map<string, MenuN>();
for (const m of MENU) for (const w of m.words) WORD_TO_N.set(w, m.n);

export function parseInput(raw: string | null | undefined): Input {
  const text = normalise(typeof raw === "string" ? raw : "");
  if (!text) return { kind: "text", text: "" };

  const slash = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (slash) {
    const word = slash[1].toLowerCase();
    const arg = (slash[2] ?? "").trim();
    if (word === "start") return { kind: "start", code: normalizeLinkCode(arg) };
    if (word === "0" || word === "help" || word === "menu") return { kind: "help", all: /^(all|everything)$/i.test(arg) };
    if (word === "cancel") return { kind: "cancel" };
    if (/^[1-6]$/.test(word)) return { kind: "menu", n: word as MenuN, arg };
    const alias = /^n([1-6])$/.exec(word); // for clients that will not let a user tap /1
    if (alias) return { kind: "menu", n: alias[1] as MenuN, arg };
    const named = WORD_TO_N.get(word);
    if (named) return { kind: "menu", n: named, arg };
    return { kind: "help", all: false };
  }

  // Typed words only count for a single line, so a pasted message is never hijacked.
  if (!/\n/.test(text)) {
    const code = normalizeLinkCode(text);
    if (code) return { kind: "link", code };
    const lower = text.toLowerCase().replace(/[.!?]+$/, "");
    if (CANCEL_WORDS.has(lower)) return { kind: "cancel" };
    if (lower === "help" || lower === "hi" || lower === "hello" || lower === "?") return { kind: "help", all: false };
    if (lower === "help all") return { kind: "help", all: true };
    const hit = WORD_TO_N.get(lower);
    if (hit) return { kind: "menu", n: hit, arg: "" };
  }
  return { kind: "text", text };
}
