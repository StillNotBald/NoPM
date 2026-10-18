import { route } from "@/lib/api/handler";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { fail, safeJson } from "@/lib/api/response";
import { generateProjectReport, DECK_FORMATS, type DeckFormat } from "@/lib/reports";

export const runtime = "nodejs";

async function handle(
  actor: Actor,
  projectId: string,
  format: string,
  sections?: string[],
): Promise<Response> {
  requireScope(actor, "audit:read");
  requireScope(actor, "budget:read"); // the project report carries budget figures (planned / committed / actual)
  if (!DECK_FORMATS.includes(format as DeckFormat)) {
    return fail("format must be one of: html, pptx, pdf", 422);
  }
  const result = await generateProjectReport(
    actor.workspaceId,
    projectId,
    format as DeckFormat,
    sections,
  );
  if (!result) return fail("Project not found", 404);
  return new Response(result.body as BodyInit, {
    headers: {
      "content-type": result.contentType,
      "content-disposition": `attachment; filename="${result.filename}"`,
    },
  });
}

/**
 * GET /api/reports/project/[id]?format=html[&sections=cover,rag,evm,risks,issues,milestones]
 *
 * Returns a per-project status report (html / pptx / pdf).
 * The project must belong to the caller's workspace.
 *
 * Optional ?sections= is a comma-separated list of section keys:
 *   cover | rag | evm | risks | issues | milestones
 * Omitting the parameter includes all sections.
 */
export const GET = route(async ({ actor, request, params }) => {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "html";
  const sectionsParam = url.searchParams.get("sections");
  const sections = sectionsParam ? sectionsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  return handle(actor, params.id, format, sections);
});

/**
 * POST /api/reports/project/[id]
 * Body: { format?: "html" | "pptx" | "pdf"; sections?: string[] }
 *
 * Identical to GET but lets agents pass a structured JSON body instead of
 * query-string manipulation (useful for long sections arrays).
 */
export const POST = route(async ({ actor, request, params }) => {
  const body = (await safeJson(request)) as {
    format?: string;
    sections?: string[];
  } | null;
  return handle(actor, params.id, body?.format ?? "html", body?.sections);
});
