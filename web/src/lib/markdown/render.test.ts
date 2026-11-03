/**
 * R-204: the shared markdown renderer (assistant panel + document viewer).
 * Rendered with react-dom/server to static markup; the suite is node-env.
 */
import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, type MarkdownOptions } from "./render";

const PANEL: MarkdownOptions = { tables: true, linkPolicy: "strict", inBubble: true };

function html(md: string, opts: MarkdownOptions = PANEL): string {
  return renderToStaticMarkup(createElement(Fragment, null, renderMarkdown(md, opts)));
}

describe("inline and blocks", () => {
  it("renders bold, italic and inline code", () => {
    const out = html("a **bold** and *it* and `code`");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>it</em>");
    expect(out).toContain("<code");
    expect(out).toContain(">code</code>");
  });

  it("keeps single line breaks as separate lines (one paragraph per line)", () => {
    const out = html("one\ntwo");
    expect(out.match(/<p /g)?.length).toBe(2);
  });

  it("renders headings", () => {
    const out = html("# A\n## B\n### C");
    expect(out).toContain("<h3");
    expect(out).toContain("<h4");
    expect(out).toContain("<h5");
  });

  it("renders bullet and ordered lists", () => {
    const out = html("- a\n- b\n\n1. x\n2. y");
    expect(out).toContain("<ul");
    expect(out.match(/<li>/g)?.length).toBe(4);
    expect(out).toContain("<ol");
  });

  it("renders a fenced code block as text, not markup", () => {
    const out = html("```\n**not bold** <b>x</b>\n```");
    expect(out).toContain("<pre");
    expect(out).not.toContain("<strong>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("pipe tables", () => {
  const TABLE = "| Name | Qty |\n|---|--:|\n| Apples | 3 |\n| **Pears** | 12 |";

  it("renders a real table inside a horizontal scroller", () => {
    const out = html(TABLE);
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("<table");
    expect(out).toContain("<thead>");
    expect(out.match(/<th /g)?.length).toBe(2);
    expect(out.match(/<tr /g)?.length).toBe(3);
    expect(out).toContain("<strong>Pears</strong>");
    expect(out).toContain("text-right");
  });

  it("works without leading/trailing pipes and pads short rows", () => {
    const out = html("A | B\n--|--\n1 |");
    expect(out).toContain("<table");
    expect(out.match(/<td /g)?.length).toBe(2);
  });

  it("does not render tables when the option is off", () => {
    expect(html(TABLE, {})).not.toContain("<table");
  });

  it("a header row without its separator yet is a plain paragraph", () => {
    const out = html("| Name | Qty |");
    expect(out).not.toContain("<table");
    expect(out).toContain("| Name | Qty |");
  });

  it("a half-streamed table settles once the rest arrives", () => {
    const parts = [TABLE.slice(0, 14), TABLE.slice(0, 22), TABLE.slice(0, 40), TABLE];
    for (const p of parts) expect(() => html(p)).not.toThrow();
    expect(html(TABLE.slice(0, 22))).toContain("<table"); // header + separator
    expect(html(TABLE)).toContain("Pears");
  });

  it("a lone --- is still a rule, not a table", () => {
    expect(html("a | b\n---")).not.toContain("<table");
  });
});

describe("links", () => {
  it("allows http(s) links in a new tab with noopener", () => {
    const out = html("[x](https://example.com/a)");
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("allows same-origin relative paths without a new tab", () => {
    const out = html("[t](/projects/1?x=2)");
    expect(out).toContain('href="/projects/1?x=2"');
    expect(out).not.toContain("_blank");
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//evil.example/x",
    "vbscript:x",
    "mailto:a@b.co",
    "java\tscript:alert(1)",
    "relative/path",
    "/\\evil.example",
  ])("blocks %s", (url) => {
    const out = html(`[click](${url})`);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    expect(out).toContain("click");
  });
});

describe("untrusted input", () => {
  it("shows raw HTML as text and never emits it as elements", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes HTML inside table cells and links", () => {
    const out = html("| a |\n|---|\n| <img src=x onerror=1> |\n\n[<i>x</i>](https://e.co)");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<i>");
  });
});

describe("partial / streaming markup never throws", () => {
  const SAMPLE = "## Title\n\nSome **bold** text with `code` and a [link](https://example.com).\n\n- a\n- b\n\n```\ncode\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";

  it("every prefix of a full reply renders", () => {
    for (let n = 0; n <= SAMPLE.length; n++) {
      expect(() => html(SAMPLE.slice(0, n))).not.toThrow();
    }
  });

  it("an unclosed ** or ` stays literal, then settles when closed", () => {
    expect(html("a **bold")).toContain("**bold");
    expect(html("a **bold**")).toContain("<strong>bold</strong>");
    expect(html("a `co")).toContain("`co");
  });

  it("an unclosed fence shows the code so far", () => {
    const out = html("```\nline one");
    expect(out).toContain("<pre");
    expect(out).toContain("line one");
  });

  it("an unfinished link stays literal", () => {
    const out = html("see [docs](https://exa");
    expect(out).not.toContain("<a ");
  });
});

describe("document viewer parity (default options)", () => {
  const DOC = [
    "# One", "## Two", "### Three", "para **b** *i* `c`", "",
    "- x", "* y", "1. p", "2. q", "---",
    "```", "fenced", "```",
    "[ok](https://example.com) [mail](mailto:a@b.co) [bad](javascript:alert(1)) [rel](/x)",
    "| a | b |", "|---|---|", "| 1 | 2 |",
  ].join("\n");

  it("viewer defaults keep the old output: no tables, mailto allowed, relative blocked", () => {
    const out = html(DOC, {});
    expect(out).not.toContain("<table");
    expect(out).toContain('href="mailto:a@b.co"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain('href="/x"');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("| a | b |");
    expect(out).toContain('<pre class="my-2 overflow-x-auto rounded-md bg-well p-3 font-mono text-xs text-ink">');
  });
});
