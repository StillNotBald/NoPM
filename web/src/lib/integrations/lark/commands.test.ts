import { describe, it, expect } from "vitest";
import { extractMessageText, parseCommand } from "./commands";

describe("parseCommand", () => {
  it.each([
    ["help", { kind: "help" }],
    ["HELP", { kind: "help" }],
    ["  Help  ", { kind: "help" }],
    ["help?", { kind: "help" }],
    ["help!", { kind: "help" }],
    ["?", { kind: "help" }],
    ["hi", { kind: "help" }],
    ["/help", { kind: "help" }],
    ["/nopm help", { kind: "help" }],
    ["nopm help", { kind: "help" }],
    ["ＨＥＬＰ", { kind: "help" }],
    ["approvals", { kind: "approvals" }],
    ["Approvals", { kind: "approvals" }],
    ["/approvals", { kind: "approvals" }],
    ["pending", { kind: "approvals" }],
  ])("%j -> %j", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it("parses link codes in any case, with or without dashes, and strips mention placeholders", () => {
    expect(parseCommand("link NPL-ABCD-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
    expect(parseCommand("link npl-abcd-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
    expect(parseCommand("Link NPLABCD2345")).toEqual({ kind: "link", code: "NPLABCD2345" });
    expect(parseCommand("/nopm link NPL-ABCD-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
    expect(parseCommand("@_user_1 link NPL-ABCD-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
    expect(parseCommand("bind NPL-ABCD-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
  });

  it("accepts a bare pasted code", () => {
    expect(parseCommand("NPL-ABCD-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
    expect(parseCommand("npl-abcd-2345")).toEqual({ kind: "link", code: "NPL-ABCD-2345" });
  });

  it("link with a missing or malformed code yields code:null (the handler explains the usage)", () => {
    expect(parseCommand("link")).toEqual({ kind: "link", code: null });
    expect(parseCommand("link   ")).toEqual({ kind: "link", code: null });
    expect(parseCommand("link !!")).toEqual({ kind: "link", code: null });
    expect(parseCommand("link x")).toEqual({ kind: "link", code: null });
    expect(parseCommand(`link ${"A".repeat(60)}`)).toEqual({ kind: "link", code: null });
  });

  it("anything else is unknown (no natural language, no extra arguments)", () => {
    for (const text of ["", "   ", "approve everything", "help me please", "approvals now", "delete project", "/unknown", "你好", null, undefined]) {
      expect(parseCommand(text as string | null | undefined)).toEqual({ kind: "unknown" });
    }
  });
});

describe("extractMessageText", () => {
  it("reads the text of a text message", () => {
    expect(extractMessageText("text", JSON.stringify({ text: "link NPL-ABCD-2345" }))).toBe("link NPL-ABCD-2345");
  });

  it("returns null for other message types and malformed content", () => {
    expect(extractMessageText("image", JSON.stringify({ image_key: "k" }))).toBeNull();
    expect(extractMessageText("post", JSON.stringify({ title: "x" }))).toBeNull();
    expect(extractMessageText("text", "{not json")).toBeNull();
    expect(extractMessageText("text", JSON.stringify({ text: 42 }))).toBeNull();
    expect(extractMessageText("text", JSON.stringify(null))).toBeNull();
    expect(extractMessageText("text", undefined)).toBeNull();
  });
});
