import type { MetadataRoute } from "next";
import { CRAWL_ALLOW, CRAWL_DISALLOW } from "@/components/marketing/crawl-rules";
import { SITE_URL } from "@/components/marketing/page-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: [...CRAWL_ALLOW], disallow: [...CRAWL_DISALLOW] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
