import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,

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
