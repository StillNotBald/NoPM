import type { PortfolioReport, ProjectReport, TopRisk, TopIssue, MilestoneRow, EvmTableRow } from "./gather";
import type { EvmResult } from "@/lib/evm";

// ─── palette ─────────────────────────────────────────────────────────────────
// App palette: white canvas / near-black ink / vibrant terminal-green accent.
// Matches globals.css light theme exactly.

export const P = {
  canvas:  "#ffffff",
  surface: "#f0f0f2",
  ink:     "#161616",
  muted:   "#8b8b90",
  line:    "#e5e5e8",
  accent:  "#0078d4",   // Fluent blue — buttons / indicators
  // semantic
  green:   "#16a34a",
  amber:   "#f59e0b",
  red:     "#e5484d",
  info:    "#2563eb",
} as const;

export const TONE: Record<string, string> = {
  green:       P.green,
  on_track:    P.green,
  amber:       P.amber,
  at_risk:     P.amber,
  red:         P.red,
  delayed:     P.red,
  complete:    P.accent,
  completed:   P.accent,
  not_started: P.muted,
};

const SEV_COLOR: Record<string, string> = {
  critical: P.red,
  high:     P.amber,
  medium:   P.muted,
  low:      P.green,
  urgent:   P.red,
};

export const esc = (s: string) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

const fmt = (n: number | null | undefined, decimals = 0): string =>
  n == null ? "—" : n.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtIdx = (n: number | null | undefined): string =>
  n == null ? "—" : n.toFixed(2);

// ─── shared CSS ──────────────────────────────────────────────────────────────

export const BASE_CSS = `
  :root{
    --canvas:${P.canvas};--surface:${P.surface};--ink:${P.ink};--muted:${P.muted};
    --line:${P.line};--accent:${P.accent};
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--canvas);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1100px;margin:0 auto;padding:56px 40px}
  .cover{min-height:260px;background:var(--ink);border-radius:14px;padding:48px 56px;margin-bottom:48px;
    display:flex;flex-direction:column;justify-content:flex-end}
  .cover h1{font-size:38px;font-weight:600;margin:0;color:#fff}
  .cover .subtitle{color:var(--accent);font-size:18px;margin:8px 0 2px;font-family:ui-monospace,"SF Mono",monospace}
  .cover .ts{color:#8b8b90;font-size:13px}
  h2{font-size:20px;font-weight:600;margin:40px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0 0 28px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:20px}
  .num{font-size:32px;font-weight:600;line-height:1} .lbl{color:var(--muted);font-size:13px;margin-top:8px}
  .reg{color:var(--ink);font-size:14px;margin:4px 0 28px}
  table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);
    border-radius:11px;overflow:hidden;margin-bottom:32px}
  th,td{text-align:left;padding:10px 14px;font-size:13px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em;
    background:var(--surface)}
  tr:last-child td{border-bottom:none}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .bar{display:inline-block;width:80px;height:6px;background:var(--line);border-radius:99px;overflow:hidden;
    margin-right:8px;vertical-align:middle}
  .bar i{display:block;height:100%;background:var(--accent)}
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:500;
    text-transform:capitalize}
  td.right,th.right{text-align:right}
  .neg{color:${P.red}} .pos{color:${P.green}} .neutral{color:${P.muted}}
  .foot{color:var(--muted);font-size:12px;margin-top:36px;border-top:1px solid var(--line);padding-top:16px}
`;

// ─── shared section builders ──────────────────────────────────────────────────

function ragSummarySection(rag: Record<string, number>, registers: { risks: number; issues: number; clashes: number }): string {
  const card = (label: string, val: number, color: string = P.accent) =>
    `<div class="card"><div class="num" style="color:${color}">${val}</div><div class="lbl">${label}</div></div>`;
  return `<h2>RAG Summary</h2>
<div class="cards">
  ${card("Green", rag.green ?? 0, P.green)}
  ${card("Amber", rag.amber ?? 0, P.amber)}
  ${card("Red", rag.red ?? 0, P.red)}
  ${card("Not Started", rag.not_started ?? 0, P.muted)}
  ${card("Complete", rag.complete ?? 0, P.accent)}
</div>
<div class="reg">Open Risks <b>${registers.risks}</b> · Open Issues <b>${registers.issues}</b> · Clashes <b>${registers.clashes}</b></div>`;
}

function evmTableSection(evmTable: EvmTableRow[]): string {
  if (!evmTable.length) return `<h2>EVM / Budget</h2><p style="color:var(--muted)">No budget data yet.</p>`;
  const rows = evmTable.map((r) => {
    const cvClass = r.cv < 0 ? "neg" : r.cv > 0 ? "pos" : "neutral";
    const cpiClass = r.cpi == null ? "neutral" : r.cpi < 1 ? "neg" : "pos";
    return `<tr>
      <td>${esc(r.project_name)}</td>
      <td class="right">${fmt(r.bac)}</td>
      <td class="right">${fmt(r.ev)}</td>
      <td class="right">${fmt(r.ac)}</td>
      <td class="right ${cvClass}">${fmt(r.cv)}</td>
      <td class="right ${cpiClass}">${fmtIdx(r.cpi)}</td>
      <td class="right">${fmtIdx(r.spi)}</td>
      <td class="right">${fmt(r.eac)}</td>
      <td class="right">${fmt(r.vac)}</td>
    </tr>`;
  }).join("");
  return `<h2>EVM / Budget</h2>
<table><thead><tr>
  <th>Project</th><th class="right">BAC</th><th class="right">EV</th><th class="right">AC</th>
  <th class="right">CV</th><th class="right">CPI</th><th class="right">SPI</th>
  <th class="right">EAC</th><th class="right">VAC</th>
</tr></thead><tbody>${rows}</tbody></table>`;
}

function topRisksSection(risks: TopRisk[], showProject = true): string {
  if (!risks.length) return `<h2>Top Risks</h2><p style="color:var(--muted)">No open risks.</p>`;
  const rows = risks.map((r) => {
    const col = SEV_COLOR[r.severity] ?? "#9a968d";
    return `<tr>
      <td>${esc(r.title)}</td>
      ${showProject ? `<td>${esc(r.project_name ?? "")}</td>` : ""}
      <td><span class="badge" style="background:${col}20;color:${col}">${esc(r.severity)}</span></td>
      <td><span class="badge" style="background:${col}20;color:${col}">${esc(r.likelihood)}</span></td>
      <td>${esc(r.status)}</td>
    </tr>`;
  }).join("");
  return `<h2>Top Risks</h2>
<table><thead><tr>
  <th>Title</th>${showProject ? "<th>Project</th>" : ""}<th>Severity</th><th>Likelihood</th><th>Status</th>
</tr></thead><tbody>${rows}</tbody></table>`;
}

function topIssuesSection(issues: TopIssue[], showProject = true): string {
  if (!issues.length) return `<h2>Top Issues</h2><p style="color:var(--muted)">No open issues.</p>`;
  const rows = issues.map((i) => {
    const col = SEV_COLOR[i.priority] ?? "#9a968d";
    return `<tr>
      <td>${esc(i.title)}</td>
      ${showProject ? `<td>${esc(i.project_name ?? "")}</td>` : ""}
      <td><span class="badge" style="background:${col}20;color:${col}">${esc(i.priority)}</span></td>
      <td>${esc(i.status)}</td>
    </tr>`;
  }).join("");
  return `<h2>Top Issues</h2>
<table><thead><tr>
  <th>Title</th>${showProject ? "<th>Project</th>" : ""}<th>Priority</th><th>Status</th>
</tr></thead><tbody>${rows}</tbody></table>`;
}

function milestonesSection(milestones: MilestoneRow[], showProject = true): string {
  if (!milestones.length) return `<h2>Milestones</h2><p style="color:var(--muted)">No upcoming milestones.</p>`;
  const rows = milestones.map((m) => {
    const col = TONE[m.status] ?? "#9a968d";
    const dateStr = m.target_date
      ? new Date(m.target_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })
      : "—";
    return `<tr>
      <td>${esc(m.name)}</td>
      ${showProject ? `<td>${esc(m.project_name ?? "")}</td>` : ""}
      <td>${dateStr}</td>
      <td><span class="badge" style="background:${col}20;color:${col}">${esc(m.status)}</span></td>
      <td>
        <div class="bar"><i style="width:${m.completion_pct}%"></i></div>${m.completion_pct}%
      </td>
    </tr>`;
  }).join("");
  return `<h2>Milestones</h2>
<table><thead><tr>
  <th>Name</th>${showProject ? "<th>Project</th>" : ""}<th>Target</th><th>Status</th><th>% Done</th>
</tr></thead><tbody>${rows}</tbody></table>`;
}

function projectsTableSection(projects: PortfolioReport["projects"]): string {
  const rows = projects.map((p) => {
    const col = TONE[p.rag_status] ?? "#9a968d";
    return `<tr>
      <td>${esc(p.code ?? "")}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.program ?? "")}</td>
      <td><span class="dot" style="background:${col}"></span>${esc(p.rag_status)}</td>
      <td><div class="bar"><i style="width:${p.completion_pct}%"></i></div>${p.completion_pct}%</td>
    </tr>`;
  }).join("");
  return `<h2>Projects</h2>
<table><thead><tr><th>Code</th><th>Name</th><th>Program</th><th>RAG</th><th>Completion</th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" style="color:var(--muted)">No projects yet</td></tr>`}</tbody></table>`;
}

// ─── available section keys ───────────────────────────────────────────────────

export const PORTFOLIO_SECTIONS = ["cover", "rag", "projects", "evm", "risks", "issues", "milestones"] as const;
export type PortfolioSection = (typeof PORTFOLIO_SECTIONS)[number];

export const PROJECT_SECTIONS = ["cover", "rag", "evm", "risks", "issues", "milestones"] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

// ─── portfolio HTML renderer ──────────────────────────────────────────────────

export function renderHtml(r: PortfolioReport, sections?: string[]): string {
  const active = sections && sections.length ? new Set(sections) : new Set(PORTFOLIO_SECTIONS as readonly string[]);
  const include = (s: string) => active.has(s);

  const parts: string[] = [];

  if (include("cover")) {
    parts.push(`<div class="cover">
      <div class="subtitle">${esc(r.workspaceName)}</div>
      <h1>Portfolio Status Report</h1>
      <div class="ts">Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM</div>
    </div>`);
  }

  if (include("rag")) {
    const totalCard = `<div class="card"><div class="num" style="color:${P.ink}">${r.projects.length}</div><div class="lbl">Projects</div></div>`;
    const body = ragSummarySection(r.rag, r.registers);
    // inject total card before the rag cards by replacing the first <div class="cards">
    parts.push(body.replace(`<div class="cards">`, `<div class="cards">${totalCard}`));
  }

  if (include("projects")) parts.push(projectsTableSection(r.projects));
  if (include("evm")) parts.push(evmTableSection(r.evmTable));
  if (include("risks")) parts.push(topRisksSection(r.topRisks, true));
  if (include("issues")) parts.push(topIssuesSection(r.topIssues, true));
  if (include("milestones")) parts.push(milestonesSection(r.milestones, true));

  const body = parts.join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(r.workspaceName)} — Portfolio Status</title>
<style>${BASE_CSS}</style></head><body><div class="wrap">
${body}
<div class="foot">Governed by NoPM — every change behind this report is captured in an immutable audit log.</div>
</div></body></html>`;
}

// ─── per-project HTML renderer ────────────────────────────────────────────────

export function renderProjectHtml(r: ProjectReport, sections?: string[]): string {
  const active = sections && sections.length ? new Set(sections) : new Set(PROJECT_SECTIONS as readonly string[]);
  const include = (s: string) => active.has(s);
  const p = r.project;

  const parts: string[] = [];

  if (include("cover")) {
    const ragCol = TONE[p.rag_status] ?? "#9a968d";
    const startStr = p.start_date
      ? new Date(p.start_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })
      : null;
    const endStr = p.target_date
      ? new Date(p.target_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })
      : null;
    const dateLine = startStr || endStr ? `${startStr ?? "—"} → ${endStr ?? "—"}` : null;
    parts.push(`<div class="cover">
      <div class="subtitle">${esc(r.workspaceName)}${p.program ? ` · ${esc(p.program)}` : ""}</div>
      <h1>${esc(p.name)}${p.code ? ` <span style="font-size:22px;font-weight:400;color:#9a968d">(${esc(p.code)})</span>` : ""}</h1>
      ${dateLine ? `<div class="ts" style="margin-top:8px">${esc(dateLine)}</div>` : ""}
      <div style="margin-top:12px">
        <span class="badge" style="background:${ragCol}30;color:${ragCol};font-size:14px;padding:4px 12px">${esc(p.rag_status)}</span>
        <span style="color:#9a968d;font-size:13px;margin-left:12px">${p.completion_pct}% complete</span>
      </div>
      <div class="ts" style="margin-top:12px">Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM</div>
    </div>`);
    if (p.description) {
      parts.push(`<p style="color:var(--muted);margin:-24px 0 32px">${esc(p.description)}</p>`);
    }
  }

  if (include("rag")) {
    const col = TONE[p.rag_status] ?? "#9a968d";
    parts.push(`<h2>Project Health</h2>
<div class="cards">
  <div class="card"><div class="num" style="color:${col}">${esc(p.rag_status)}</div><div class="lbl">RAG Status</div></div>
  <div class="card"><div class="num" style="color:var(--accent)">${p.completion_pct}%</div><div class="lbl">Completion</div></div>
  <div class="card"><div class="num" style="color:${P.amber}">${r.registers.risks}</div><div class="lbl">Open Risks</div></div>
  <div class="card"><div class="num" style="color:${P.red}">${r.registers.issues}</div><div class="lbl">Open Issues</div></div>
</div>`);
  }

  if (include("evm")) {
    const evm: EvmResult = r.evm;
    const cvClass = evm.cv < 0 ? "neg" : evm.cv > 0 ? "pos" : "neutral";
    const cpiClass = evm.cpi == null ? "neutral" : evm.cpi < 1 ? "neg" : "pos";
    parts.push(`<h2>EVM / Budget</h2>
<div class="cards">
  <div class="card"><div class="num">${fmt(evm.bac)}</div><div class="lbl">BAC (Budget)</div></div>
  <div class="card"><div class="num">${fmt(evm.ev)}</div><div class="lbl">EV (Earned)</div></div>
  <div class="card"><div class="num">${fmt(evm.ac)}</div><div class="lbl">AC (Actual)</div></div>
  <div class="card"><div class="num ${cvClass}">${fmt(evm.cv)}</div><div class="lbl">CV (Cost Var)</div></div>
  <div class="card"><div class="num ${cpiClass}">${fmtIdx(evm.cpi)}</div><div class="lbl">CPI</div></div>
  <div class="card"><div class="num">${fmtIdx(evm.spi)}</div><div class="lbl">SPI</div></div>
  <div class="card"><div class="num">${fmt(evm.eac)}</div><div class="lbl">EAC</div></div>
  <div class="card"><div class="num">${fmt(evm.vac)}</div><div class="lbl">VAC</div></div>
</div>
<p style="color:var(--muted);font-size:12px;margin-top:-16px">Currency: ${esc(p.currency)} · SPI = 1.00 when no schedule baseline is set.</p>`);
  }

  if (include("risks")) parts.push(topRisksSection(r.topRisks, false));
  if (include("issues")) parts.push(topIssuesSection(r.topIssues, false));
  if (include("milestones")) parts.push(milestonesSection(r.milestones, false));

  const bodyHtml = parts.join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(p.name)} — Project Status</title>
<style>${BASE_CSS}</style></head><body><div class="wrap">
${bodyHtml}
<div class="foot">Governed by NoPM — every change behind this report is captured in an immutable audit log.</div>
</div></body></html>`;
}
