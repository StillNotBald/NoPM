import { gatherPortfolio, gatherProject } from "./gather";
import { renderHtml, renderProjectHtml } from "./html";
import { renderPptx, renderProjectPptx } from "./pptx";
import { renderPdf, renderProjectPdf } from "./pdf";

export type DeckFormat = "html" | "pptx" | "pdf";
export const DECK_FORMATS: DeckFormat[] = ["html", "pptx", "pdf"];

export interface DeckResult {
  body: string | Buffer;
  contentType: string;
  filename: string;
}

/** Generate the full portfolio board pack, optionally filtered to a subset of sections. */
export async function generateDeck(
  workspaceId: string,
  format: DeckFormat,
  sections?: string[],
): Promise<DeckResult> {
  const report = await gatherPortfolio(workspaceId);
  switch (format) {
    case "pptx":
      return {
        body: await renderPptx(report, sections),
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename: "nopm-portfolio.pptx",
      };
    case "pdf":
      return {
        body: renderPdf(report, sections),
        contentType: "application/pdf",
        filename: "nopm-portfolio.pdf",
      };
    default:
      return {
        body: renderHtml(report, sections),
        contentType: "text/html; charset=utf-8",
        filename: "nopm-portfolio.html",
      };
  }
}

/** Generate a single-project status report, optionally filtered to a subset of sections. */
export async function generateProjectReport(
  workspaceId: string,
  projectId: string,
  format: DeckFormat,
  sections?: string[],
): Promise<DeckResult | null> {
  const report = await gatherProject(workspaceId, projectId);
  if (!report) return null;

  const slug = (report.project.code ?? report.project.name.slice(0, 16).replace(/\s+/g, "-")).toLowerCase();
  switch (format) {
    case "pptx":
      return {
        body: await renderProjectPptx(report, sections),
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename: `nopm-project-${slug}.pptx`,
      };
    case "pdf":
      return {
        body: renderProjectPdf(report, sections),
        contentType: "application/pdf",
        filename: `nopm-project-${slug}.pdf`,
      };
    default:
      return {
        body: renderProjectHtml(report, sections),
        contentType: "text/html; charset=utf-8",
        filename: `nopm-project-${slug}.html`,
      };
  }
}
