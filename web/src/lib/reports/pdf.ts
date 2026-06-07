import { jsPDF } from "jspdf";
import type { PortfolioReport } from "./gather";

/** Board-pack PDF, built from data. */
export function renderPdf(r: PortfolioReport): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();

  doc.setFillColor(250, 249, 245);
  doc.rect(0, 0, W, H, "F");

  doc.setTextColor(44, 42, 38);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  doc.text(r.workspaceName, 40, 84);

  doc.setTextColor(217, 119, 87);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(15);
  doc.text("Portfolio Status — NoPM", 40, 108);

  doc.setTextColor(107, 104, 99);
  doc.setFontSize(10);
  doc.text(`Generated ${new Date(r.generatedAt).toLocaleString()}`, 40, 126);

  doc.setTextColor(44, 42, 38);
  doc.setFontSize(13);
  doc.text(
    `Projects ${r.projects.length}      Green ${r.rag.green ?? 0}      Amber ${r.rag.amber ?? 0}      Red ${r.rag.red ?? 0}`,
    40, 168,
  );
  doc.text(
    `Risks ${r.registers.risks}      Issues ${r.registers.issues}      Clashes ${r.registers.clashes}`,
    40, 188,
  );

  let y = 230;
  doc.setFontSize(10);
  doc.setTextColor(107, 104, 99);
  doc.text("CODE", 40, y);
  doc.text("NAME", 130, y);
  doc.text("RAG", 380, y);
  doc.text("%", 470, y);
  y += 8;
  doc.setDrawColor(229, 226, 218);
  doc.line(40, y, W - 40, y);
  y += 18;

  doc.setTextColor(44, 42, 38);
  doc.setFontSize(11);
  for (const p of r.projects) {
    doc.text(String(p.code ?? ""), 40, y);
    doc.text(p.name.slice(0, 44), 130, y);
    doc.text(p.rag_status, 380, y);
    doc.text(String(p.completion_pct), 470, y);
    y += 18;
    if (y > H - 60) {
      doc.addPage();
      doc.setFillColor(250, 249, 245);
      doc.rect(0, 0, W, H, "F");
      y = 60;
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}
