import type { MetadataRoute } from "next";
import { PUBLIC_PAGES } from "@/components/marketing/crawl-rules";
import { SITE_URL } from "@/components/marketing/page-metadata";

// The public pages only. No `lastModified`: a build-time `new Date()` would
// claim a freshness nobody verified, and an honest absence beats a made-up date.
export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PAGES.map((path) => ({
    url: path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`,
    changeFrequency: "monthly" as const,
    priority: path === "/" ? 1 : 0.8,
  }));
}
