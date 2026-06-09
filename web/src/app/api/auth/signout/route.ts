import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/auth/signout — sign the current session out via the server
 * Supabase client (cookie-based). No auth guard — the user calling this may
 * already have an invalid token; we always attempt signOut and succeed.
 */
export async function POST(): Promise<Response> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ data: { ok: true } });
}
