import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Self-contained server bundle (server.js + minimal node_modules) so the
  // Docker runtime image doesn't need the full node_modules tree or the
  // Next.js CLI — see web/Dockerfile and docs/SELF_HOSTING.md.
  output: "standalone",

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: buildSecurityHeaders({
          isProd: process.env.NODE_ENV === "production",
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        }),
      },
    ];
  },
};

export default nextConfig;
