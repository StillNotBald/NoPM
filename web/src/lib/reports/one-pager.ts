/**
 * one-pager.ts — client-side jsPDF generator for the NoPM case study one-pager.
 *
 * Produces a clean single-page A4 PDF: title, thesis, wedges, build summary,
 * proof metrics, and the live URL. Palette and typography match the existing
 * pdf.ts report theme (white canvas / near-black ink / terminal-green accent).
 */

import { jsPDF } from "jspdf";
import metrics from "@/lib/metrics.gen.json";

// ─── palette (mirrors pdf.ts + globals.css) ───────────────────────────────────
const C_INK:    [number, number, number] = [22,  22,  22];   // #161616
const C_CANVAS: [number, number, number] = [255, 255, 255];  // #ffffff
const C_SUNKEN: [number, number, number] = [240, 240, 242];  // #f0f0f2
const C_LINE:   [number, number, number] = [229, 229, 232];  // #e5e5e8
const C_ACCENT: [number, number, number] = [0,   166,   0];  // #00a600 terminal-green
const C_MUTED:  [number, number, number] = [139, 139, 144];  // #8b8b90
const C_WHITE:  [number, number, number] = [255, 255, 255];

// ─── content ──────────────────────────────────────────────────────────────────

const THESIS =
  "I build the systems that make unclear requirements impossible — governance " +
  "engineered into the data layer, not bolted onto the UI.";

const WEDGES: [string, string][] = [
  [
    "AI-native / agent-operable",
    "Every action is a documented REST endpoint. Scoped Bearer tokens " +
      "(resource:action), an OpenAPI spec, an llms.txt index, and a nopm CLI " +
      "let any agent drive the tool over plain HTTP — same surface as the web console.",
  ],
  [
    "Institutional governance",
    "Every mutation writes exactly one append-only audit row via writeAudit(). " +
      "Destructive deletes require maker-checker four-eyes approval — enforced by " +
      "Postgres triggers and constraints; a service key cannot rewrite history.",
  ],
  [
    "The whole PM triangle",
    "Timeline, resource, and budget in one governed model. Budget variance and EVM " +
      "roll up from actuals; schedule slip surfaces as a forced rebaseline sign-off; " +
      "over-allocation appears as a governed clash — the gap most lite PM tools miss.",
  ],
];

const BUILD_MODULES = [
  "Workspace → Project → Milestone → Task (typed statuses + maker-checker delete)",
  "Risk & Issue registers with severity/likelihood scoring",
  "Clash engine — schedule, resource, and dependency conflicts (cross-project)",
  "Resource, allocation, timesheets, cost-rate, capacity tracking",
  "Budget: planned / committed / actual / variance / EVM (CPI, SPI, EAC, VAC)",
  "Governed Kanban (drag = audited mutation) + read-mostly Gantt with rebaseline gate",
  "Trust Center — immutable audit stream, provenance, PAT management",
  "BYOK governed assistant (user's own API key, AES-256-GCM, ephemeral scoped token)",
  "Documents & charter management (doc_type versioning, status workflow)",
  "Change-control pipeline, notifications, deck export (PDF / PPTX / HTML)",
];

// Generated from the RTM, the test run, and the API route tree
// (scripts/gen-metrics.mjs); CI fails if they drift from reality.
const METRICS: [string, string][] = [
  [String(metrics.rids), "traced requirements (R-IDs) in RTM"],
  [String(metrics.tests), "governance-focused tests (vitest)"],
  [String(metrics.endpoints), "documented REST endpoints + OpenAPI"],
  ["1", "immutable audit row per mutation — no exceptions"],
  ["0", "bundled LLM — governance ships without any model key"],
];

// ─── drawing helpers ──────────────────────────────────────────────────────────

function textLines(doc: jsPDF, text: string, x: number, maxW: number, size: number): string[] {
  doc.setFontSize(size);
  return doc.splitTextToSize(text, maxW) as string[];
}

// ─── main export ─────────────────────────────────────────────────────────────

export function generateOnePager(): void {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "portrait" });
  const W = doc.internal.pageSize.getWidth();   // 595.28
  const H = doc.internal.pageSize.getHeight();  // 841.89
  const M = 40; // margin

  // ── white canvas ──
  doc.setFillColor(...C_CANVAS);
  doc.rect(0, 0, W, H, "F");

  // ── header band (near-black) ──
  const headerH = 128;
  doc.setFillColor(...C_INK);
  doc.rect(0, 0, W, headerH, "F");

  // accent label
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...C_ACCENT);
  doc.text("AI-NATIVE · GOVERNANCE-GRADE · LITE PM", M, 28);

  // product name
  doc.setFont("helvetica", "bold");
  doc.setFontSize(28);
  doc.setTextColor(...C_WHITE);
  doc.text("NoPM", M, 60);

  // sub-label
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...C_MUTED);
  doc.text("Project governance your AI agent can operate", M, 78);

  // thesis block inside header
  doc.setFont("helvetica", "italic");
  doc.setFontSize(10.5);
  doc.setTextColor(...C_WHITE);
  const thesisLines = textLines(doc, `"${THESIS}"`, M, W - 2 * M, 10.5);
  doc.text(thesisLines, M, 100);

  // live URL top-right
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...C_ACCENT);
  doc.text("stillnotbald.com", W - M, 28, { align: "right" });

  let y = headerH + 22;

  // ── section: differentiation wedges ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...C_ACCENT);
  doc.text("WHY IT'S DIFFERENT", M, y);
  y += 5;
  doc.setDrawColor(...C_LINE);
  doc.line(M, y, W - M, y);
  y += 14;

  const wedgeW = (W - 2 * M - 12) / 3;
  WEDGES.forEach(([title, body], i) => {
    const x = M + i * (wedgeW + 6);

    // card background
    doc.setFillColor(...C_SUNKEN);
    doc.roundedRect(x, y - 4, wedgeW, 94, 5, 5, "F");

    // title
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(...C_INK);
    doc.text(title, x + 8, y + 10);

    // body
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...C_MUTED);
    const bLines = textLines(doc, body, x, wedgeW - 16, 8.5);
    doc.text(bLines.slice(0, 7), x + 8, y + 24);
  });
  y += 106;

  // ── section: what was built ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...C_ACCENT);
  doc.text("WHAT WAS BUILT", M, y);
  y += 5;
  doc.setDrawColor(...C_LINE);
  doc.line(M, y, W - M, y);
  y += 14;

  const col1W = (W - 2 * M - 8) / 2;
  const half = Math.ceil(BUILD_MODULES.length / 2);

  BUILD_MODULES.forEach((mod, i) => {
    const col = i < half ? 0 : 1;
    const row = i < half ? i : i - half;
    const x = M + col * (col1W + 8);
    const ry = y + row * 14;

    // bullet dot
    doc.setFillColor(...C_ACCENT);
    doc.circle(x + 3, ry - 3.5, 2, "F");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...C_INK);
    const lines = textLines(doc, mod, x, col1W - 12, 8.5);
    doc.text(lines[0] ?? "", x + 10, ry);
  });

  y += half * 14 + 12;

  // ── section: proof metrics ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...C_ACCENT);
  doc.text("PROOF METRICS", M, y);
  y += 5;
  doc.setDrawColor(...C_LINE);
  doc.line(M, y, W - M, y);
  y += 14;

  const metricW = (W - 2 * M - 16) / METRICS.length;
  METRICS.forEach(([num, label], i) => {
    const x = M + i * (metricW + 4);
    doc.setFillColor(...C_SUNKEN);
    doc.roundedRect(x, y - 4, metricW, 52, 5, 5, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(...C_ACCENT);
    doc.text(num, x + metricW / 2, y + 20, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...C_MUTED);
    const llines = textLines(doc, label, x, metricW - 8, 7.5);
    doc.text(llines, x + metricW / 2, y + 35, { align: "center" });
  });
  y += 62;

  // ── governance terminal snippet ──
  const snippetH = 72;
  doc.setFillColor(...C_INK);
  doc.roundedRect(M, y, W - 2 * M, snippetH, 6, 6, "F");

  // traffic lights
  const tlY = y + 14;
  const dots: [number, [number, number, number]][] = [
    [M + 14, [255, 95, 87]],
    [M + 28, [254, 188, 46]],
    [M + 42, [40,  200, 64]],
  ];
  dots.forEach(([dx, col]) => {
    doc.setFillColor(...col);
    doc.circle(dx, tlY, 4, "F");
  });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(255, 255, 255, 0.4);
  doc.setTextColor(139, 139, 144);
  doc.text("agent drives NoPM", M + 58, tlY + 3);

  const codeY = y + 30;
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  const codeLines = [
    { text: "$ nopm tasks rm task_8f3a --reason \"superseded\"", color: [200, 200, 200] as [number, number, number] },
    { text: "  ⏸  pending four-eyes approval (different token required)", color: [139, 139, 144] as [number, number, number] },
    { text: "$ nopm approve req_2c91   →   ✓ committed · 1 immutable audit row written", color: [0, 166, 0] as [number, number, number] },
  ];
  codeLines.forEach(({ text, color }, i) => {
    doc.setTextColor(...color);
    doc.text(text, M + 10, codeY + i * 12);
  });
  y += snippetH + 14;

  // ── builder credit ──
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...C_MUTED);
  doc.text(
    "Built solo using an AI multi-agent workflow · stillnotbald.com",
    W / 2,
    y,
    { align: "center" },
  );

  // ── footer rule ──
  y += 10;
  doc.setDrawColor(...C_LINE);
  doc.line(M, y, W - M, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...C_MUTED);
  doc.text(
    "NoPM — governance built into the data layer. Every mutation is immutably audited. No bundled LLM.",
    W / 2,
    y,
    { align: "center" },
  );

  // ── trigger download ──
  doc.save("nopm-case-study.pdf");
}
