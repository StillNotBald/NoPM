import { OG_CONTENT_TYPE, OG_SIZE, renderOgCard } from "@/components/marketing/og-card";

// Next drops the root segment's file-based image when this page sets its own
// `openGraph` (it does, via pageMetadata), so the case study keeps its own.
export const alt = "NoPM case study: I build the systems that make unclear requirements impossible.";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image() {
  return renderOgCard({
    label: "Portfolio case study",
    headline: "I build the systems that make unclear requirements impossible.",
    headlineSize: 50,
  });
}
