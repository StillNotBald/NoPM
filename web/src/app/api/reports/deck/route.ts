import { route } from "@/lib/api/handler";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { fail, safeJson } from "@/lib/api/response";
import { generateDeck, DECK_FORMATS, type DeckFormat } from "@/lib/reports";

export const runtime = "nodejs";

async function handle(
  actor: Actor,
  format: string,
  sections?: string[],
): Promise<Response> {
  requireScope(actor, "audit:read"); // report generation is read-only over portfolio data
  requireScope(actor, "budget:read"); // ...but the deck carries budget figures (planned / committed / actual)
  if (!DECK_FORMATS.includes(format as DeckFormat)) {
    return fail("format must be one of: html, pptx, pdf", 422);
  }
  const { body, contentType, filename } = await generateDeck(
    actor.workspaceId,
    format as DeckFormat,
    sections,
  );
  return new Response(body as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

// GET /api/reports/deck?format=pptx[&sections=cover,rag,evm]
export const GET = route(async ({ actor, request }) => {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "html";
  const sectionsParam = url.searchParams.get("sections");
  const sections = sectionsParam ? sectionsParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  return handle(actor, format, sections);
});

// POST /api/reports/deck { format, sections?: string[] }
export const POST = route(async ({ actor, request }) => {
  const body = (await safeJson(request)) as { format?: string; sections?: string[] } | null;
  return handle(actor, body?.format ?? "html", body?.sections);
});
