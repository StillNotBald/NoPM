import { describe, it, expect } from "vitest";
import { MENU, canUse, commandList, menuDiffersFromDefault, menuFor, parseInput, toRole } from "./commands";
import { cb, esc, helpCard, linkPrompt } from "./render";

describe("parseInput", () => {
  it.each([
    ["/1", { kind: "menu", n: "1", arg: "" }],
    ["/5 Alpha beta", { kind: "menu", n: "5", arg: "Alpha beta" }],
    ["/1@example_bot", { kind: "menu", n: "1", arg: "" }],
    ["/n2", { kind: "menu", n: "2", arg: "" }],
    ["tasks", { kind: "menu", n: "1", arg: "" }],
    ["Add", { kind: "menu", n: "2", arg: "" }],
    ["approvals", { kind: "menu", n: "4", arg: "" }],
    ["/digest", { kind: "menu", n: "6", arg: "" }],
    ["/0", { kind: "help", all: false }],
    ["/0 all", { kind: "help", all: true }],
    ["/help", { kind: "help", all: false }],
    ["help all", { kind: "help", all: true }],
    ["hi", { kind: "help", all: false }],
    ["/nonsense", { kind: "help", all: false }],
    ["cancel", { kind: "cancel" }],
    ["Cancel!", { kind: "cancel" }],
    ["/cancel", { kind: "cancel" }],
    ["/start", { kind: "start", code: null }],
    ["/start npl-abcd-2345", { kind: "start", code: "NPL-ABCD-2345" }],
    ["/start garbage", { kind: "start", code: null }],
    ["NPL-ABCD-2345", { kind: "link", code: "NPL-ABCD-2345" }],
    ["Ｔａｓｋｓ", { kind: "menu", n: "1", arg: "" }],
  ])("%j -> %j", (text, expected) => {
    expect(parseInput(text)).toEqual(expected);
  });

  it("a longer or multi-line message is free text, never a hijacked command", () => {
    expect(parseInput("add a task about the roof")).toEqual({ kind: "text", text: "add a task about the roof" });
    expect(parseInput("tasks\nline two")).toEqual({ kind: "text", text: "tasks\nline two" });
    expect(parseInput("cancel my subscription please")).toEqual({ kind: "text", text: "cancel my subscription please" });
  });

  it("strips zero-width characters and handles empty or missing text", () => {
    expect(parseInput("​/1​")).toEqual({ kind: "menu", n: "1", arg: "" });
    expect(parseInput("")).toEqual({ kind: "text", text: "" });
    expect(parseInput(undefined)).toEqual({ kind: "text", text: "" });
  });
});

describe("role-aware menu", () => {
  it("members and above get add and update; viewers are read-only; approvals are admin and manager", () => {
    expect(menuFor("member").map((m) => m.n)).toEqual(["1", "2", "3", "5", "6"]);
    expect(menuFor("viewer").map((m) => m.n)).toEqual(["1", "5", "6"]);
    expect(menuFor("manager").map((m) => m.n)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(canUse("member", "4")).toBe(false);
    expect(canUse("admin", "4")).toBe(true);
    expect(canUse("viewer", "2")).toBe(false);
  });

  it("registers digits as Telegram commands (a-z0-9_ only, 32 chars max) with /0 last", () => {
    for (const r of ["admin", "manager", "member", "viewer"] as const) {
      const list = commandList(r);
      expect(list[list.length - 1]).toEqual({ command: "0", description: "Help and menu" });
      for (const c of list) {
        expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(c.description.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("only roles whose menu differs from the default need a per-chat scope", () => {
    expect(menuDiffersFromDefault("member")).toBe(false);
    expect(menuDiffersFromDefault("manager")).toBe(true);
    expect(menuDiffersFromDefault("admin")).toBe(true);
    expect(menuDiffersFromDefault("viewer")).toBe(true);
  });

  it("unknown roles fall back to member", () => {
    expect(toRole("owner")).toBe("member");
    expect(toRole(undefined)).toBe("member");
    expect(MENU).toHaveLength(6);
  });
});

describe("render helpers", () => {
  it("escapes HTML and strips bidi controls", () => {
    expect(esc("<script>&‮")).toBe("&lt;script&gt;&amp;");
  });

  it("cb refuses callback_data over 64 bytes", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(Buffer.byteLength(cb("ap", id), "utf8")).toBeLessThanOrEqual(64);
    expect(() => cb("ap", id, "x".repeat(40))).toThrow(/64/);
  });

  it("the help card of an unlinked chat is the link prompt", () => {
    expect(helpCard(null, false)).toEqual(linkPrompt());
  });
});
