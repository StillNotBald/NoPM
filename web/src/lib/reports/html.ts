import type { PortfolioReport } from "./gather";

const TONE: Record<string, string> = {
  green: "#5f8c58",
  amber: "#c69749",
  red: "#b85450",
  complete: "#d97757",
  not_started: "#9a968d",
};
const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

export function renderHtml(r: PortfolioReport): string {
  const card = (label: string, val: number, color = "#d97757") =>
    `<div class="card"><div class="num" style="color:${color}">${val}</div><div class="lbl">${label}</div></div>`;
  const rows = r.projects
    .map(
      (p) =>
        `<tr><td>${esc(p.code ?? "")}</td><td>${esc(p.name)}</td><td>${esc(p.program ?? "")}</td>` +
        `<td><span class="dot" style="background:${TONE[p.rag_status] ?? "#9a968d"}"></span>${p.rag_status}</td>` +
        `<td><div class="bar"><i style="width:${p.completion_pct}%"></i></div>${p.completion_pct}%</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(r.workspaceName)} — Portfolio Status</title>
<style>
  :root{--cream:#faf9f5;--surface:#f5f4ee;--ink:#2c2a26;--muted:#6b6863;--line:#e5e2da;--coral:#d97757}
  *{box-sizing:border-box} body{margin:0;background:var(--cream);color:var(--ink);
    font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:56px 40px}
  h1{font-size:34px;font-weight:600;margin:0} .sub{color:var(--coral);font-size:18px;margin:6px 0 2px}
  .ts{color:var(--muted);font-size:13px}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:32px 0}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px}
  .num{font-size:34px;font-weight:600;line-height:1} .lbl{color:var(--muted);font-size:13px;margin-top:8px}
  .reg{color:var(--ink);font-size:14px;margin:4px 0 28px}
  table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  th,td{text-align:left;padding:12px 16px;font-size:14px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  tr:last-child td{border-bottom:none}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}
  .bar{display:inline-block;width:90px;height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin-right:8px;vertical-align:middle}
  .bar i{display:block;height:100%;background:var(--coral)}
  .foot{color:var(--muted);font-size:12px;margin-top:36px;border-top:1px solid var(--line);padding-top:16px}
</style></head><body><div class="wrap">
  <h1>${esc(r.workspaceName)}</h1>
  <div class="sub">Portfolio Status</div>
  <div class="ts">Generated ${new Date(r.generatedAt).toLocaleString()} · NoPM</div>
  <div class="cards">
    ${card("Projects", r.projects.length, "#2c2a26")}
    ${card("Green", r.rag.green ?? 0, "#5f8c58")}
    ${card("Amber", r.rag.amber ?? 0, "#c69749")}
    ${card("Red", r.rag.red ?? 0, "#b85450")}
  </div>
  <div class="reg">Risks <b>${r.registers.risks}</b> · Issues <b>${r.registers.issues}</b> · Clashes <b>${r.registers.clashes}</b></div>
  <table><thead><tr><th>Code</th><th>Name</th><th>Program</th><th>RAG</th><th>Completion</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="5" style="color:var(--muted)">No projects yet</td></tr>`}</tbody></table>
  <div class="foot">Governed by NoPM — every change behind this report is captured in an immutable audit log.</div>
</div></body></html>`;
}
