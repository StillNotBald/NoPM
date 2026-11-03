import type { ReactNode } from "react";

/**
 * Small, dependency-free markdown renderer shared by the document viewer and
 * the assistant panel.
 *
 * SECURITY: input may be untrusted model output. This builds React elements
 * only. There is no dangerouslySetInnerHTML and no raw HTML pass-through (a
 * `<script>` in the input is shown as text). Link targets are checked against
 * an allow-list; anything else renders as inert text.
 *
 * Handles: # ## ### headings, **bold**, *italic*, `inline code`, ``` fences,
 * [text](url) links, - bullet lists, 1. ordered lists, --- rules and (opt-in)
 * GitHub-style pipe tables. Half-finished markup (streaming) never throws: an
 * unclosed ** or ` stays literal text, an unclosed fence shows the code so far,
 * a header row without its |---| line is a paragraph until the line arrives.
 */

export interface MarkdownOptions {
  /** Render GitHub pipe tables. Default false (the document viewer predates them). */
  tables?: boolean;
  /**
   * "viewer": http(s) and mailto, always opened in a new tab (document viewer).
   * "strict": http(s) and same-origin relative paths ("/x"), nothing else.
   */
  linkPolicy?: "viewer" | "strict";
  /** Inside a tinted bubble: code and table borders use the canvas/border tokens. */
  inBubble?: boolean;
}

// ── Links ─────────────────────────────────────────────────────────────────────

type LinkKind = "external" | "internal" | null;

function classifyHref(url: string, policy: "viewer" | "strict"): LinkKind {
  const u = url.trim();
  if (policy === "viewer") return /^(https?:|mailto:)/i.test(u) ? "external" : null;
  // Control characters and whitespace can hide a scheme from the check below.
  if (u === "" || /[\u0000- \u007f-\u009f\\]/.test(u)) return null;
  if (/^https?:\/\/[^/]/i.test(u)) return "external";
  // Same-origin relative path: starts with one "/" (not "//", which is protocol-relative).
  if (u.startsWith("/") && !u.startsWith("//")) return "internal";
  return null;
}

// ── Inline ────────────────────────────────────────────────────────────────────

function parseInline(text: string, opts: MarkdownOptions): ReactNode {
  const policy = opts.linkPolicy ?? "viewer";
  const codeCls = opts.inBubble
    ? "rounded border border-border-subtle bg-canvas px-1 py-0.5 font-mono text-xs text-ink"
    : "rounded bg-well px-1 py-0.5 font-mono text-xs text-ink";
  const parts: ReactNode[] = [];
  // Pattern: **bold** | *italic* | `code` | [label](url)
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2] !== undefined) {
      parts.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4] !== undefined) {
      parts.push(
        <code key={match.index} className={codeCls}>
          {match[4]}
        </code>,
      );
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const kind = classifyHref(match[6], policy);
      if (kind === null) {
        parts.push(<span key={match.index}>{match[5]}</span>);
      } else if (kind === "internal") {
        parts.push(
          <a key={match.index} href={match[6].trim()} rel="noopener noreferrer"
            className="text-accent underline underline-offset-2">
            {match[5]}
          </a>,
        );
      } else {
        parts.push(
          <a key={match.index} href={match[6]} target="_blank" rel="noopener noreferrer"
            className="text-accent underline underline-offset-2">
            {match[5]}
          </a>,
        );
      }
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── Tables ────────────────────────────────────────────────────────────────────

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** `|---|:--:|` style separator line (must contain a pipe so a lone `---` stays a rule). */
function isSeparator(line: string): boolean {
  const s = line.trim();
  if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s)) return false;
  return s.includes("|");
}

function alignOf(cell: string): "left" | "right" | "center" {
  const c = cell.trim();
  if (c.startsWith(":") && c.endsWith(":") && c.length > 1) return "center";
  if (c.endsWith(":")) return "right";
  return "left";
}

const ALIGN_CLASS = { left: "text-left", right: "text-right", center: "text-center" } as const;

// ── Blocks ────────────────────────────────────────────────────────────────────

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): ReactNode {
  const lines = md.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  let i = 0;
  const pre = opts.inBubble
    ? "my-2 overflow-x-auto rounded-md border border-border-subtle bg-canvas p-3 font-mono text-xs text-ink"
    : "my-2 overflow-x-auto rounded-md bg-well p-3 font-mono text-xs text-ink";

  while (i < lines.length) {
    const line = lines[i];

    // Code fence (``` block)
    if (line.startsWith("```")) {
      const fenceLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        fenceLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre key={`fence-${i}`} className={pre}>
          <code>{fenceLines.join("\n")}</code>
        </pre>,
      );
      i++; // skip closing ```
      continue;
    }

    // Pipe table: header row, then a |---| separator line, then body rows.
    if (opts.tables && line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const start = i;
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const alignAt = (c: number) => ALIGN_CLASS[aligns[c] ?? "left"];
      nodes.push(
        <div key={`tbl-${start}`} className="my-2 max-w-full overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-ink-muted">
                {head.map((h, c) => (
                  <th key={c} className={`px-2 py-1 font-medium ${alignAt(c)}`}>{parseInline(h, opts)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-border-subtle last:border-0">
                  {head.map((_, c) => (
                    <td key={c} className={`px-2 py-1 text-ink ${alignAt(c)}`}>{parseInline(r[c] ?? "", opts)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading ### h3
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      nodes.push(<h5 key={`h3-${i}`} className="mt-3 text-sm font-semibold text-ink">{parseInline(h3[1], opts)}</h5>);
      i++; continue;
    }

    // Heading ## h2
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      nodes.push(<h4 key={`h2-${i}`} className="mt-4 text-base font-semibold text-ink">{parseInline(h2[1], opts)}</h4>);
      i++; continue;
    }

    // Heading # h1
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      nodes.push(<h3 key={`h1-${i}`} className="mt-4 text-lg font-bold text-ink">{parseInline(h1[1], opts)}</h3>);
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${i}`} className="my-3 border-border-subtle" />);
      i++; continue;
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-1 ml-4 list-disc space-y-0.5 text-sm text-ink">
          {items.map((it, idx) => <li key={idx}>{parseInline(it, opts)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-1 ml-4 list-decimal space-y-0.5 text-sm text-ink">
          {items.map((it, idx) => <li key={idx}>{parseInline(it, opts)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      nodes.push(<div key={`gap-${i}`} className="my-1" />);
      i++; continue;
    }

    // Paragraph (one per source line, so single line breaks are kept)
    nodes.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed text-ink">
        {parseInline(line, opts)}
      </p>,
    );
    i++;
  }

  return <>{nodes}</>;
}
