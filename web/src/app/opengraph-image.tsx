import { OG_CONTENT_TYPE, OG_SIZE, renderOgCard } from "@/components/marketing/og-card";

// Link-unfurl image for the landing page (and any page that sets no image of
// its own). Same words as the page's h1 and description — see page-metadata.ts.
export const alt = "NoPM: project governance your AI agent can operate. A terminal showing an agent's delete request, a second token's approval, and the audit row.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image() {
  return renderOgCard({
    headline: "Project governance your AI agent can operate.",
    sub: "Immutable audit, scoped tokens, four-eyes approval — enforced in the data layer.",
  });
}
