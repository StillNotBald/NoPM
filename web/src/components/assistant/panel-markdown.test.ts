/**
 * R-204: assistant replies render as safe markdown in the panel; user
 * messages stay plain text.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { MessageBubble } from "./panel";

const TABLE = "Here you go:\n\n| Project | Status |\n|---|---|\n| Alpha | **On track** |\n\n- one\n- two";

function bubble(role: "user" | "assistant", content: string, streaming = false): string {
  return renderToStaticMarkup(createElement(MessageBubble, { msg: { role, content, streaming } }));
}

describe("assistant panel message bubble", () => {
  it("renders an assistant reply with a table as a real, scrollable <table>", () => {
    const out = bubble("assistant", TABLE);
    expect(out).toContain("<table");
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("<strong>On track</strong>");
    expect(out).toContain("<ul");
    expect(out).not.toContain("**On track**");
  });

  it("keeps a user message as plain text (no markdown parsing)", () => {
    const out = bubble("user", TABLE);
    expect(out).not.toContain("<table");
    expect(out).not.toContain("<strong>");
    expect(out).toContain("| Project | Status |");
    expect(out).toContain("**On track**");
  });

  it("renders a half-streamed assistant reply without crashing", () => {
    expect(() => bubble("assistant", "| A | B |\n|---|", true)).not.toThrow();
    expect(() => bubble("assistant", "so **bol", true)).not.toThrow();
  });

  it("never emits raw HTML or javascript: links from the model", () => {
    const out = bubble("assistant", "<img src=x onerror=alert(1)> [x](javascript:alert(1))");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("href=");
  });
});
