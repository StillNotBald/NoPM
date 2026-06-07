import { route } from "@/lib/api/handler";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { fail, safeJson } from "@/lib/api/response";
import { generateDeck, DECK_FORMATS, type DeckFormat } from "@/lib/reports";

export const runtime = "nodejs";

async function handle(actor: Actor, format: string): Promise<Response> {
  requireScope(actor, "audit:read"); // report generation is read-only over portfolio data
  if (!DECK_FORMATS.includes(format as DeckFormat)) {
    return fail("format must be one of: html, pptx, pdf", 422);
  }
  const { body, contentType, filename } = await generateDeck(actor.workspaceId, format as DeckFormat);
  return new Response(body as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

// GET /api/reports/deck?format=pptx — easy browser/agent download
export const GET = route(async ({ actor, request }) => {
  const format = new URL(request.url).searchParams.get("format") ?? "html";
  return handle(actor, format);
});

// POST /api/reports/deck { format }
export const POST = route(async ({ actor, request }) => {
  const body = (await safeJson(request)) as { format?: string } | null;
  return handle(actor, body?.format ?? "html");
});
