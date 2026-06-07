import pptxgen from "pptxgenjs";
import type { PortfolioReport } from "./gather";

const CORAL = "D97757";
const INK = "2C2A26";
const MUTED = "6B6863";
const CREAM = "FAF9F5";
const SURFACE = "F5F4EE";
const LINE = "E5E2DA";

/** Editable .pptx portfolio deck, built from data (no DOM capture). */
export async function renderPptx(r: PortfolioReport): Promise<Buffer> {
  const p = new pptxgen();
  p.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  p.layout = "WIDE";

  // Title
  let s = p.addSlide();
  s.background = { color: CREAM };
  s.addText(r.workspaceName, { x: 0.7, y: 2.5, w: 12, h: 1, fontSize: 40, bold: true, color: INK });
  s.addText("Portfolio Status — NoPM", { x: 0.7, y: 3.5, w: 12, h: 0.5, fontSize: 20, color: CORAL });
  s.addText(`Generated ${new Date(r.generatedAt).toLocaleString()}`, {
    x: 0.7, y: 6.6, w: 12, h: 0.4, fontSize: 12, color: MUTED,
  });

  // Health
  s = p.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("Portfolio health", { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: INK });
  const cards: [string, number, string][] = [
    ["Projects", r.projects.length, INK],
    ["Green", r.rag.green ?? 0, "5F8C58"],
    ["Amber", r.rag.amber ?? 0, "C69749"],
    ["Red", r.rag.red ?? 0, "B85450"],
  ];
  cards.forEach(([label, val, color], i) => {
    const x = 0.7 + i * 3.1;
    s.addShape(p.ShapeType.roundRect, {
      x, y: 1.4, w: 2.9, h: 1.7, fill: { color: SURFACE }, line: { color: LINE, width: 1 }, rectRadius: 0.12,
    });
    s.addText(String(val), { x, y: 1.6, w: 2.9, h: 0.9, fontSize: 40, bold: true, color, align: "center" });
    s.addText(label, { x, y: 2.5, w: 2.9, h: 0.4, fontSize: 14, color: MUTED, align: "center" });
  });
  s.addText(
    `Risks ${r.registers.risks}    ·    Issues ${r.registers.issues}    ·    Clashes ${r.registers.clashes}`,
    { x: 0.7, y: 3.5, w: 12, h: 0.4, fontSize: 16, color: INK },
  );

  // Projects table
  s = p.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText("Projects", { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: INK });
  const header = ["Code", "Name", "Program", "RAG", "%"].map((t) => ({
    text: t, options: { bold: true, color: MUTED, fill: { color: SURFACE } },
  }));
  const body = r.projects.map((pr) =>
    [pr.code ?? "", pr.name, pr.program ?? "", pr.rag_status, String(pr.completion_pct)].map(
      (text) => ({ text }),
    ),
  );
  s.addTable([header, ...body], {
    x: 0.7, y: 1.3, w: 12, color: INK, fontSize: 12,
    border: { type: "solid", color: LINE, pt: 1 },
    colW: [1.6, 4.2, 3.2, 1.8, 1.2],
  });

  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}
