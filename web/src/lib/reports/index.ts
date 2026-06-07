import { gatherPortfolio } from "./gather";
import { renderHtml } from "./html";
import { renderPptx } from "./pptx";
import { renderPdf } from "./pdf";

export type DeckFormat = "html" | "pptx" | "pdf";
export const DECK_FORMATS: DeckFormat[] = ["html", "pptx", "pdf"];

export async function generateDeck(
  workspaceId: string,
  format: DeckFormat,
): Promise<{ body: string | Buffer; contentType: string; filename: string }> {
  const report = await gatherPortfolio(workspaceId);
  switch (format) {
    case "pptx":
      return {
        body: await renderPptx(report),
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename: "nopm-portfolio.pptx",
      };
    case "pdf":
      return { body: renderPdf(report), contentType: "application/pdf", filename: "nopm-portfolio.pdf" };
    default:
      return { body: renderHtml(report), contentType: "text/html; charset=utf-8", filename: "nopm-portfolio.html" };
  }
}
