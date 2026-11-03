import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Cloudflare Workers host (ADR 0021, off by default; Vercel ignores this file).
// A static-assets incremental cache plus cache interception serves the
// prerendered pages from the asset store. Without them every prerendered page is
// rendered per request (3 to 15 s TTFB was measured on another OpenNext app before this was set).
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
