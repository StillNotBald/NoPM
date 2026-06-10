import pptxgen from "pptxgenjs";
import type { PortfolioReport, ProjectReport, TopRisk, TopIssue, MilestoneRow, EvmTableRow } from "./gather";
import type { EvmResult } from "@/lib/evm";

// ─── palette ─────────────────────────────────────────────────────────────────
// Matches app globals.css light theme: white canvas / near-black ink /
// vibrant terminal-green accent. No cream/coral.

const INK     = "161616";
const MUTED   = "8B8B90";
const SURFACE = "F0F0F2";
const LINE    = "E5E5E8";
const WHITE   = "FFFFFF";
const ACCENT  = "00A600"; // vibrant terminal-green
const GREEN   = "16A34A";
const AMBER   = "F59E0B";
const RED     = "E5484D";

const TONE: Record<string, string> = {
  green:       GREEN,
  on_track:    GREEN,
  amber:       AMBER,
  at_risk:     AMBER,
  delayed:     RED,
  red:         RED,
  complete:    ACCENT,
  completed:   ACCENT,
  not_started: MUTED,
};


const fmt = (n: number | null | undefined, decimals = 0): string =>
  n == null ? "—" : n.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtIdx = (n: number | null | undefined): string =>
  n == null ? "—" : n.toFixed(2);

// ─── slide helpers ────────────────────────────────────────────────────────────

function addCoverSlide(p: pptxgen, title: string, subtitle: string, ts: string): void {
  const s = p.addSlide();
  s.background = { color: INK };
  s.addText(subtitle, { x: 0.7, y: 2.0, w: 12, h: 0.5, fontSize: 16, color: ACCENT });
  s.addText(title, { x: 0.7, y: 2.6, w: 12, h: 1.2, fontSize: 36, bold: true, color: WHITE });
  s.addText(ts, { x: 0.7, y: 6.6, w: 12, h: 0.4, fontSize: 11, color: MUTED });
}

function addRagSlide(
  p: pptxgen,
  heading: string,
  cards: [string, string | number, string][],
  subtitle?: string,
): void {
  const s = p.addSlide();
  s.background = { color: WHITE };
  s.addText(heading, { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, bold: true, color: INK });
  cards.forEach(([label, val, color], i) => {
    const x = 0.7 + i * 2.5;
    s.addShape(p.ShapeType.roundRect, {
      x, y: 1.4, w: 2.3, h: 1.6, fill: { color: SURFACE }, line: { color: LINE, width: 1 }, rectRadius: 0.1,
    });
    s.addText(String(val), { x, y: 1.55, w: 2.3, h: 0.85, fontSize: 34, bold: true, color, align: "center" });
    s.addText(label, { x, y: 2.45, w: 2.3, h: 0.35, fontSize: 12, color: MUTED, align: "center" });
  });
  if (subtitle) {
    s.addText(subtitle, { x: 0.7, y: 3.3, w: 12, h: 0.4, fontSize: 13, color: INK });
  }
}

function addTableSlide(
  p: pptxgen,
  heading: string,
  header: string[],
  rows: string[][],
  colW: number[],
  emptyMsg = "No data.",
): void {
  const s = p.addSlide();
  s.background = { color: WHITE };
  s.addText(heading, { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, bold: true, color: INK });
  if (!rows.length) {
    s.addText(emptyMsg, { x: 0.7, y: 1.5, w: 12, h: 0.5, fontSize: 14, color: MUTED });
    return;
  }
  const headerRow = header.map((t) => ({
    text: t,
    options: { bold: true, color: MUTED, fill: { color: SURFACE } },
  }));
  const bodyRows = rows.map((cells) => cells.map((text) => ({ text })));
  s.addTable([headerRow, ...bodyRows], {
    x: 0.7, y: 1.3, w: 12, color: INK, fontSize: 11,
    border: { type: "solid", color: LINE, pt: 1 },
    colW,
  });
}

function addEvmSlide(p: pptxgen, evmTable: EvmTableRow[]): void {
  const rows = evmTable.map((r) => [
    r.project_name.slice(0, 28),
    fmt(r.bac),
    fmt(r.ev),
    fmt(r.ac),
    fmt(r.cv),
    fmtIdx(r.cpi),
    fmtIdx(r.spi),
    fmt(r.eac),
    fmt(r.vac),
  ]);
  addTableSlide(
    p, "EVM / Budget",
    ["Project", "BAC", "EV", "AC", "CV", "CPI", "SPI", "EAC", "VAC"],
    rows,
    [2.8, 1.1, 1.1, 1.1, 1.1, 0.9, 0.9, 1.1, 0.9],
    "No budget data yet.",
  );
}

function addRisksSlide(p: pptxgen, risks: TopRisk[], showProject = true): void {
  const rows = risks.map((r) => {
    const base = [r.title.slice(0, 40), r.severity, r.likelihood, r.status];
    return showProject ? [r.project_name?.slice(0, 20) ?? "", ...base] : base;
  });
  const header = showProject
    ? ["Project", "Title", "Severity", "Likelihood", "Status"]
    : ["Title", "Severity", "Likelihood", "Status"];
  const colW = showProject ? [2.0, 5.0, 1.5, 1.5, 2.0] : [7.0, 1.5, 1.5, 2.0];
  addTableSlide(p, "Top Risks", header, rows, colW, "No open risks.");
}

function addIssuesSlide(p: pptxgen, issues: TopIssue[], showProject = true): void {
  const rows = issues.map((i) => {
    const base = [i.title.slice(0, 45), i.priority, i.status];
    return showProject ? [i.project_name?.slice(0, 22) ?? "", ...base] : base;
  });
  const header = showProject ? ["Project", "Title", "Priority", "Status"] : ["Title", "Priority", "Status"];
  const colW = showProject ? [2.0, 6.0, 2.0, 2.0] : [8.0, 2.0, 2.0];
  addTableSlide(p, "Top Issues", header, rows, colW, "No open issues.");
}

function addMilestonesSlide(p: pptxgen, milestones: MilestoneRow[], showProject = true): void {
  const rows = milestones.map((m) => {
    const dateStr = m.target_date
      ? new Date(m.target_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "2-digit" })
      : "—";
    const base = [m.name.slice(0, 35), dateStr, m.status, `${m.completion_pct}%`];
    return showProject ? [m.project_name?.slice(0, 22) ?? "", ...base] : base;
  });
  const header = showProject
    ? ["Project", "Milestone", "Target", "Status", "%"]
    : ["Milestone", "Target", "Status", "%"];
  const colW = showProject ? [2.0, 4.5, 1.5, 2.5, 1.5] : [7.5, 1.5, 2.0, 1.0];
  addTableSlide(p, "Milestones", header, rows, colW, "No milestones found.");
}

function addEvmSingleSlide(p: pptxgen, evm: EvmResult, currency: string): void {
  const s = p.addSlide();
  s.background = { color: WHITE };
  s.addText("EVM / Budget", { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 24, bold: true, color: INK });

  const cells: [string, number | null, string][] = [
    ["BAC", evm.bac, INK],
    ["EV", evm.ev, INK],
    ["AC", evm.ac, INK],
    ["CV", evm.cv, evm.cv < 0 ? RED : GREEN],
    ["CPI", evm.cpi, evm.cpi == null ? MUTED : evm.cpi < 1 ? RED : GREEN],
    ["SPI", evm.spi, evm.spi == null ? MUTED : evm.spi < 1 ? AMBER : GREEN],
    ["EAC", evm.eac, INK],
    ["VAC", evm.vac, evm.vac == null ? MUTED : evm.vac < 0 ? RED : GREEN],
  ];
  cells.forEach(([label, val, color], i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 0.7 + col * 3.1;
    const y = 1.4 + row * 2.0;
    s.addShape(p.ShapeType.roundRect, {
      x, y, w: 2.9, h: 1.6, fill: { color: SURFACE }, line: { color: LINE, width: 1 }, rectRadius: 0.1,
    });
    const display = typeof val === "number" && Math.abs(val) < 100 && label !== "BAC" && label !== "EV" && label !== "AC" && label !== "EAC" && label !== "VAC"
      ? fmtIdx(val)
      : fmt(val);
    s.addText(display, { x, y: y + 0.15, w: 2.9, h: 0.85, fontSize: 26, bold: true, color, align: "center" });
    s.addText(label, { x, y: y + 1.0, w: 2.9, h: 0.35, fontSize: 12, color: MUTED, align: "center" });
  });
  s.addText(`Currency: ${currency} · SPI = 1.00 when no schedule baseline is set.`, {
    x: 0.7, y: 5.8, w: 12, h: 0.4, fontSize: 10, color: MUTED,
  });
}

// ─── portfolio PPTX renderer ──────────────────────────────────────────────────

export async function renderPptx(r: PortfolioReport, sections?: string[]): Promise<Buffer> {
  const active = sections && sections.length
    ? new Set(sections)
    : new Set(["cover", "rag", "projects", "evm", "risks", "issues", "milestones"]);
  const include = (s: string) => active.has(s);

  const p = new pptxgen();
  p.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  p.layout = "WIDE";

  if (include("cover")) {
    addCoverSlide(
      p,
      "Portfolio Status Report",
      r.workspaceName,
      `Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM`,
    );
  }

  if (include("rag")) {
    addRagSlide(
      p,
      "RAG Summary",
      [
        ["Projects", r.projects.length, INK],
        ["Green", r.rag.green ?? 0, GREEN],
        ["Amber", r.rag.amber ?? 0, AMBER],
        ["Red", r.rag.red ?? 0, RED],
        ["Complete", r.rag.complete ?? 0, ACCENT],
      ],
      `Open Risks ${r.registers.risks}    ·    Open Issues ${r.registers.issues}    ·    Clashes ${r.registers.clashes}`,
    );
  }

  if (include("projects")) {
    const rows = r.projects.map((pr) => [
      pr.code ?? "",
      pr.name.slice(0, 30),
      pr.program ?? "",
      pr.rag_status,
      `${pr.completion_pct}%`,
    ]);
    addTableSlide(p, "Projects", ["Code", "Name", "Program", "RAG", "%"], rows, [1.5, 4.0, 3.0, 2.0, 1.5]);
  }

  if (include("evm")) addEvmSlide(p, r.evmTable);
  if (include("risks")) addRisksSlide(p, r.topRisks, true);
  if (include("issues")) addIssuesSlide(p, r.topIssues, true);
  if (include("milestones")) addMilestonesSlide(p, r.milestones, true);

  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}

// ─── per-project PPTX renderer ────────────────────────────────────────────────

export async function renderProjectPptx(r: ProjectReport, sections?: string[]): Promise<Buffer> {
  const active = sections && sections.length
    ? new Set(sections)
    : new Set(["cover", "rag", "evm", "risks", "issues", "milestones"]);
  const include = (s: string) => active.has(s);

  const p = new pptxgen();
  p.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  p.layout = "WIDE";

  const proj = r.project;
  const ragCol = TONE[proj.rag_status] ?? MUTED;

  if (include("cover")) {
    const s = p.addSlide();
    s.background = { color: INK };
    const programLine = [r.workspaceName, proj.program].filter(Boolean).join(" · ");
    s.addText(programLine, { x: 0.7, y: 1.8, w: 12, h: 0.5, fontSize: 16, color: ACCENT });
    const titleLine = proj.code ? `${proj.name}  (${proj.code})` : proj.name;
    s.addText(titleLine, { x: 0.7, y: 2.4, w: 12, h: 1.0, fontSize: 32, bold: true, color: WHITE });
    s.addText(`RAG: ${proj.rag_status.toUpperCase()}   |   ${proj.completion_pct}% complete`, {
      x: 0.7, y: 3.55, w: 10, h: 0.5, fontSize: 16, color: ragCol,
    });
    if (proj.target_date) {
      s.addText(`Target: ${new Date(proj.target_date).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })}`, {
        x: 0.7, y: 4.1, w: 10, h: 0.4, fontSize: 13, color: MUTED,
      });
    }
    s.addText(`Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM`, {
      x: 0.7, y: 6.6, w: 12, h: 0.4, fontSize: 11, color: MUTED,
    });
  }

  if (include("rag")) {
    addRagSlide(
      p,
      "Project Health",
      [
        ["RAG Status", proj.rag_status, ragCol],
        ["Completion", `${proj.completion_pct}%`, ACCENT],
        ["Open Risks", r.registers.risks, AMBER],
        ["Open Issues", r.registers.issues, RED],
      ],
    );
  }

  if (include("evm")) addEvmSingleSlide(p, r.evm, proj.currency);
  if (include("risks")) addRisksSlide(p, r.topRisks, false);
  if (include("issues")) addIssuesSlide(p, r.topIssues, false);
  if (include("milestones")) addMilestonesSlide(p, r.milestones, false);

  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}
