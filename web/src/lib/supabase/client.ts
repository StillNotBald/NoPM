import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client (publishable/anon key). Respects RLS.
 * Used by Client Components for auth (session) only — all data access
 * goes through NoPM's own /api routes, never directly from the browser.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
