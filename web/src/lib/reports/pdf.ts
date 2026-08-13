import { jsPDF } from "jspdf";
import type { PortfolioReport, ProjectReport } from "./gather";
import type { EvmResult } from "@/lib/evm";

// ─── palette (RGB tuples) ─────────────────────────────────────────────────────
// Matches app globals.css light theme: white canvas / near-black ink /
// vibrant terminal-green accent. No cream/coral.

const C_INK:     [number, number, number] = [22,  22,  22];   // #161616
const C_CANVAS:  [number, number, number] = [255, 255, 255];  // #ffffff
const C_SURFACE: [number, number, number] = [240, 240, 242];  // #f0f0f2
const C_LINE:    [number, number, number] = [229, 229, 232];  // #e5e5e8
const C_ACCENT:  [number, number, number] = [0,   120, 212];  // #0078d4 Fluent blue
const C_MUTED:   [number, number, number] = [139, 139, 144];  // #8b8b90
const C_GREEN:   [number, number, number] = [22,  163,  74];  // #16a34a
const C_AMBER:   [number, number, number] = [245, 158,  11];  // #f59e0b
const C_RED:     [number, number, number] = [229,  72,  77];  // #e5484d
const C_WHITE:   [number, number, number] = [255, 255, 255];

const TONE_RGB: Record<string, [number, number, number]> = {
  green:       C_GREEN,  on_track:    C_GREEN,
  amber:       C_AMBER,  at_risk:     C_AMBER,
  red:         C_RED,    delayed:     C_RED,
  complete:    C_ACCENT, completed:   C_ACCENT,
  not_started: C_MUTED,
};

const SEV_RGB: Record<string, [number, number, number]> = {
  critical: C_RED, high: C_AMBER, medium: C_MUTED, low: C_GREEN,
  urgent:   C_RED,
};

const fmt = (n: number | null | undefined, decimals = 0): string =>
  n == null ? "—" : n.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtIdx = (n: number | null | undefined): string =>
  n == null ? "—" : n.toFixed(2);

// ─── PDF drawing helpers ──────────────────────────────────────────────────────

interface DocState {
  doc: jsPDF;
  W: number;
  H: number;
  y: number;
  margin: number;
}

function newPage(state: DocState): void {
  state.doc.addPage();
  state.doc.setFillColor(...C_CANVAS);
  state.doc.rect(0, 0, state.W, state.H, "F");
  state.y = 56;
}

function checkY(state: DocState, needed = 30): void {
  if (state.y + needed > state.H - 50) newPage(state);
}

function sectionHeading(state: DocState, text: string): void {
  checkY(state, 40);
  state.doc.setFont("helvetica", "bold");
  state.doc.setFontSize(15);
  state.doc.setTextColor(...C_INK);
  state.doc.text(text, state.margin, state.y);
  state.y += 4;
  state.doc.setDrawColor(...C_LINE);
  state.doc.line(state.margin, state.y, state.W - state.margin, state.y);
  state.y += 14;
}

function columnHeaders(state: DocState, cols: { label: string; x: number }[]): void {
  state.doc.setFont("helvetica", "normal");
  state.doc.setFontSize(9);
  state.doc.setTextColor(...C_MUTED);
  for (const c of cols) state.doc.text(c.label.toUpperCase(), c.x, state.y);
  state.y += 6;
  state.doc.setDrawColor(...C_LINE);
  state.doc.line(state.margin, state.y, state.W - state.margin, state.y);
  state.y += 12;
}

// ─── portfolio PDF renderer ───────────────────────────────────────────────────

export function renderPdf(r: PortfolioReport, sections?: string[]): Buffer {
  const active = sections && sections.length
    ? new Set(sections)
    : new Set(["cover", "rag", "projects", "evm", "risks", "issues", "milestones"]);
  const include = (s: string) => active.has(s);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const margin = 40;
  const state: DocState = { doc, W, H, y: 0, margin };

  // ── Cover ──
  if (include("cover")) {
    doc.setFillColor(...C_INK);
    doc.rect(0, 0, W, H / 2.8, "F");

    doc.setTextColor(...C_ACCENT);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(13);
    doc.text(r.workspaceName, margin, 72);

    doc.setTextColor(...C_WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(28);
    doc.text("Portfolio Status Report", margin, 104);

    doc.setTextColor(...C_MUTED);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(`Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM`, margin, 126);

    state.y = H / 2.8 + 32;
    doc.setFillColor(...C_CANVAS);
    doc.rect(0, H / 2.8, W, H - H / 2.8, "F");
  } else {
    doc.setFillColor(...C_CANVAS);
    doc.rect(0, 0, W, H, "F");
    state.y = 56;
  }

  // ── RAG Summary ──
  if (include("rag")) {
    sectionHeading(state, "RAG Summary");

    const cardW = (W - 2 * margin - 16) / 5;
    const cards: [string, string | number, [number, number, number]][] = [
      ["Projects", r.projects.length, C_INK],
      ["Green", r.rag.green ?? 0, C_GREEN],
      ["Amber", r.rag.amber ?? 0, C_AMBER],
      ["Red", r.rag.red ?? 0, C_RED],
      ["Complete", r.rag.complete ?? 0, C_ACCENT],
    ];
    cards.forEach(([label, val, color], i) => {
      const x = margin + i * (cardW + 4);
      doc.setFillColor(...C_SURFACE);
      doc.roundedRect(x, state.y - 6, cardW, 50, 6, 6, "F");
      doc.setTextColor(...color);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(22);
      doc.text(String(val), x + cardW / 2, state.y + 22, { align: "center" });
      doc.setTextColor(...C_MUTED);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(label, x + cardW / 2, state.y + 38, { align: "center" });
    });
    state.y += 66;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...C_INK);
    doc.text(
      `Open Risks ${r.registers.risks}   ·   Open Issues ${r.registers.issues}   ·   Clashes ${r.registers.clashes}`,
      margin, state.y,
    );
    state.y += 24;
  }

  // ── Projects table ──
  if (include("projects")) {
    checkY(state, 60);
    sectionHeading(state, "Projects");
    const cols = [
      { label: "Code", x: margin },
      { label: "Name", x: margin + 60 },
      { label: "Program", x: margin + 230 },
      { label: "RAG", x: margin + 350 },
      { label: "%", x: margin + 430 },
    ];
    columnHeaders(state, cols);

    doc.setFontSize(10);
    for (const p of r.projects) {
      checkY(state, 20);
      const col = TONE_RGB[p.rag_status] ?? C_MUTED;
      doc.setTextColor(...C_INK);
      doc.text(String(p.code ?? ""), cols[0].x, state.y);
      doc.text(p.name.slice(0, 32), cols[1].x, state.y);
      doc.text((p.program ?? "").slice(0, 22), cols[2].x, state.y);
      doc.setTextColor(...col);
      doc.text(p.rag_status, cols[3].x, state.y);
      doc.setTextColor(...C_INK);
      doc.text(`${p.completion_pct}%`, cols[4].x, state.y);
      state.y += 18;
    }
    state.y += 8;
  }

  // ── EVM table ──
  if (include("evm")) {
    if (!r.evmTable.length) {
      sectionHeading(state, "EVM / Budget");
      doc.setFontSize(11);
      doc.setTextColor(...C_MUTED);
      doc.text("No budget data yet.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "EVM / Budget");
      const cols = [
        { label: "Project", x: margin },
        { label: "BAC", x: margin + 150 },
        { label: "EV", x: margin + 210 },
        { label: "AC", x: margin + 270 },
        { label: "CV", x: margin + 330 },
        { label: "CPI", x: margin + 390 },
        { label: "SPI", x: margin + 430 },
        { label: "EAC", x: margin + 470 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(9.5);
      for (const row of r.evmTable) {
        checkY(state, 20);
        const cvColor = row.cv < 0 ? C_RED : row.cv > 0 ? C_GREEN : C_INK;
        const cpiColor = row.cpi == null ? C_MUTED : row.cpi < 1 ? C_RED : C_GREEN;
        doc.setTextColor(...C_INK);
        doc.text(row.project_name.slice(0, 22), cols[0].x, state.y);
        doc.text(fmt(row.bac), cols[1].x, state.y);
        doc.text(fmt(row.ev), cols[2].x, state.y);
        doc.text(fmt(row.ac), cols[3].x, state.y);
        doc.setTextColor(...cvColor);
        doc.text(fmt(row.cv), cols[4].x, state.y);
        doc.setTextColor(...cpiColor);
        doc.text(fmtIdx(row.cpi), cols[5].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(fmtIdx(row.spi), cols[6].x, state.y);
        doc.text(fmt(row.eac), cols[7].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // ── Top Risks ──
  if (include("risks")) {
    if (!r.topRisks.length) {
      sectionHeading(state, "Top Risks");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No open risks.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Top Risks");
      const cols = [
        { label: "Title", x: margin },
        { label: "Project", x: margin + 200 },
        { label: "Severity", x: margin + 340 },
        { label: "Status", x: margin + 430 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const rk of r.topRisks) {
        checkY(state, 20);
        const col = SEV_RGB[rk.severity] ?? C_MUTED;
        doc.setTextColor(...C_INK);
        doc.text(rk.title.slice(0, 32), cols[0].x, state.y);
        doc.text((rk.project_name ?? "").slice(0, 20), cols[1].x, state.y);
        doc.setTextColor(...col);
        doc.text(rk.severity, cols[2].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(rk.status, cols[3].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // ── Top Issues ──
  if (include("issues")) {
    if (!r.topIssues.length) {
      sectionHeading(state, "Top Issues");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No open issues.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Top Issues");
      const cols = [
        { label: "Title", x: margin },
        { label: "Project", x: margin + 200 },
        { label: "Priority", x: margin + 350 },
        { label: "Status", x: margin + 430 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const iss of r.topIssues) {
        checkY(state, 20);
        const col = SEV_RGB[iss.priority] ?? C_MUTED;
        doc.setTextColor(...C_INK);
        doc.text(iss.title.slice(0, 32), cols[0].x, state.y);
        doc.text((iss.project_name ?? "").slice(0, 20), cols[1].x, state.y);
        doc.setTextColor(...col);
        doc.text(iss.priority, cols[2].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(iss.status, cols[3].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // ── Milestones ──
  if (include("milestones")) {
    if (!r.milestones.length) {
      sectionHeading(state, "Milestones");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No upcoming milestones.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Milestones");
      const cols = [
        { label: "Name", x: margin },
        { label: "Project", x: margin + 180 },
        { label: "Target", x: margin + 330 },
        { label: "Status", x: margin + 420 },
        { label: "%", x: margin + 500 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const m of r.milestones) {
        checkY(state, 20);
        const col = TONE_RGB[m.status] ?? C_MUTED;
        const dateStr = m.target_date
          ? new Date(m.target_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "2-digit" })
          : "—";
        doc.setTextColor(...C_INK);
        doc.text(m.name.slice(0, 28), cols[0].x, state.y);
        doc.text((m.project_name ?? "").slice(0, 20), cols[1].x, state.y);
        doc.text(dateStr, cols[2].x, state.y);
        doc.setTextColor(...col);
        doc.text(m.status, cols[3].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(`${m.completion_pct}%`, cols[4].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // footer
  doc.setFontSize(9);
  doc.setTextColor(...C_MUTED);
  doc.text("Governed by NoPM — every change behind this report is captured in an immutable audit log.", margin, H - 24);

  return Buffer.from(doc.output("arraybuffer"));
}

// ─── per-project PDF renderer ─────────────────────────────────────────────────

export function renderProjectPdf(r: ProjectReport, sections?: string[]): Buffer {
  const active = sections && sections.length
    ? new Set(sections)
    : new Set(["cover", "rag", "evm", "risks", "issues", "milestones"]);
  const include = (s: string) => active.has(s);

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const margin = 40;
  const proj = r.project;
  const state: DocState = { doc, W, H, y: 0, margin };

  const ragColor = TONE_RGB[proj.rag_status] ?? C_MUTED;

  // ── Cover ──
  if (include("cover")) {
    doc.setFillColor(...C_INK);
    doc.rect(0, 0, W, H / 2.8, "F");

    doc.setTextColor(...C_ACCENT);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    const programLine = [r.workspaceName, proj.program].filter(Boolean).join(" · ");
    doc.text(programLine, margin, 68);

    doc.setTextColor(...C_WHITE);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(26);
    const titleLine = proj.code ? `${proj.name}  (${proj.code})` : proj.name;
    doc.text(titleLine.slice(0, 55), margin, 98);

    doc.setTextColor(...ragColor);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(13);
    doc.text(`${proj.rag_status.toUpperCase()}   ·   ${proj.completion_pct}% complete`, margin, 118);

    if (proj.target_date) {
      doc.setTextColor(...C_MUTED);
      doc.setFontSize(10);
      doc.text(
        `Target: ${new Date(proj.target_date).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric" })}`,
        margin, 133,
      );
    }

    doc.setTextColor(...C_MUTED);
    doc.setFontSize(10);
    doc.text(`Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM`, margin, 152);

    state.y = H / 2.8 + 32;
    doc.setFillColor(...C_CANVAS);
    doc.rect(0, H / 2.8, W, H - H / 2.8, "F");

    if (proj.description) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(11);
      doc.setTextColor(...C_MUTED);
      const lines = doc.splitTextToSize(proj.description, W - 2 * margin);
      doc.text(lines.slice(0, 3), margin, state.y);
      state.y += lines.slice(0, 3).length * 14 + 12;
    }
  } else {
    doc.setFillColor(...C_CANVAS);
    doc.rect(0, 0, W, H, "F");
    state.y = 56;
  }

  // ── RAG / Health ──
  if (include("rag")) {
    sectionHeading(state, "Project Health");
    const cardW = (W - 2 * margin - 12) / 4;
    const cards: [string, string | number, [number, number, number]][] = [
      ["RAG Status", proj.rag_status, ragColor],
      ["Completion", `${proj.completion_pct}%`, C_ACCENT],
      ["Open Risks", r.registers.risks, C_AMBER],
      ["Open Issues", r.registers.issues, C_RED],
    ];
    cards.forEach(([label, val, color], i) => {
      const x = margin + i * (cardW + 4);
      doc.setFillColor(...C_SURFACE);
      doc.roundedRect(x, state.y - 6, cardW, 50, 6, 6, "F");
      doc.setTextColor(...color);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text(String(val), x + cardW / 2, state.y + 18, { align: "center" });
      doc.setTextColor(...C_MUTED);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(label, x + cardW / 2, state.y + 34, { align: "center" });
    });
    state.y += 62;
  }

  // ── EVM ──
  if (include("evm")) {
    sectionHeading(state, "EVM / Budget");
    const evm: EvmResult = r.evm;
    const evmItems: [string, string, [number, number, number]][] = [
      ["BAC", fmt(evm.bac), C_INK],
      ["EV", fmt(evm.ev), C_INK],
      ["AC", fmt(evm.ac), C_INK],
      ["CV", fmt(evm.cv), evm.cv < 0 ? C_RED : C_GREEN],
      ["CPI", fmtIdx(evm.cpi), evm.cpi == null ? C_MUTED : evm.cpi < 1 ? C_RED : C_GREEN],
      ["SPI", fmtIdx(evm.spi), evm.spi == null ? C_MUTED : evm.spi < 1 ? C_AMBER : C_GREEN],
      ["EAC", fmt(evm.eac), C_INK],
      ["VAC", fmt(evm.vac), evm.vac == null ? C_MUTED : evm.vac < 0 ? C_RED : C_GREEN],
    ];
    const cardW2 = (W - 2 * margin - 28) / 4;
    evmItems.forEach(([label, val, color], i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = margin + col * (cardW2 + 4);
      const y = state.y + row * 56 - 6;
      doc.setFillColor(...C_SURFACE);
      doc.roundedRect(x, y, cardW2, 50, 5, 5, "F");
      doc.setTextColor(...color);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.text(String(val), x + cardW2 / 2, y + 20, { align: "center" });
      doc.setTextColor(...C_MUTED);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(label, x + cardW2 / 2, y + 36, { align: "center" });
    });
    state.y += 2 * 56 + 14;

    doc.setFontSize(9);
    doc.setTextColor(...C_MUTED);
    doc.text(`Currency: ${proj.currency} · SPI = 1.00 when no schedule baseline is set.`, margin, state.y);
    state.y += 18;
  }

  // ── Risks ──
  if (include("risks")) {
    if (!r.topRisks.length) {
      sectionHeading(state, "Top Risks");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No open risks.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Top Risks");
      const cols = [
        { label: "Title", x: margin },
        { label: "Severity", x: margin + 300 },
        { label: "Likelihood", x: margin + 380 },
        { label: "Status", x: margin + 460 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const rk of r.topRisks) {
        checkY(state, 20);
        const col = SEV_RGB[rk.severity] ?? C_MUTED;
        doc.setTextColor(...C_INK);
        doc.text(rk.title.slice(0, 45), cols[0].x, state.y);
        doc.setTextColor(...col);
        doc.text(rk.severity, cols[1].x, state.y);
        doc.text(rk.likelihood, cols[2].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(rk.status, cols[3].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // ── Issues ──
  if (include("issues")) {
    if (!r.topIssues.length) {
      sectionHeading(state, "Top Issues");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No open issues.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Top Issues");
      const cols = [
        { label: "Title", x: margin },
        { label: "Priority", x: margin + 320 },
        { label: "Status", x: margin + 420 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const iss of r.topIssues) {
        checkY(state, 20);
        const col = SEV_RGB[iss.priority] ?? C_MUTED;
        doc.setTextColor(...C_INK);
        doc.text(iss.title.slice(0, 48), cols[0].x, state.y);
        doc.setTextColor(...col);
        doc.text(iss.priority, cols[1].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(iss.status, cols[2].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  // ── Milestones ──
  if (include("milestones")) {
    if (!r.milestones.length) {
      sectionHeading(state, "Milestones");
      doc.setFontSize(11); doc.setTextColor(...C_MUTED);
      doc.text("No milestones.", margin, state.y);
      state.y += 20;
    } else {
      checkY(state, 60);
      sectionHeading(state, "Milestones");
      const cols = [
        { label: "Name", x: margin },
        { label: "Target", x: margin + 270 },
        { label: "Status", x: margin + 370 },
        { label: "%", x: margin + 470 },
      ];
      columnHeaders(state, cols);
      doc.setFontSize(10);
      for (const m of r.milestones) {
        checkY(state, 20);
        const col = TONE_RGB[m.status] ?? C_MUTED;
        const dateStr = m.target_date
          ? new Date(m.target_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "2-digit" })
          : "—";
        doc.setTextColor(...C_INK);
        doc.text(m.name.slice(0, 40), cols[0].x, state.y);
        doc.text(dateStr, cols[1].x, state.y);
        doc.setTextColor(...col);
        doc.text(m.status, cols[2].x, state.y);
        doc.setTextColor(...C_INK);
        doc.text(`${m.completion_pct}%`, cols[3].x, state.y);
        state.y += 17;
      }
      state.y += 8;
    }
  }

  doc.setFontSize(9);
  doc.setTextColor(...C_MUTED);
  doc.text("Governed by NoPM — every change behind this report is captured in an immutable audit log.", margin, H - 24);

  return Buffer.from(doc.output("arraybuffer"));
}
