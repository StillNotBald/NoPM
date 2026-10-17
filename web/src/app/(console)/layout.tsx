import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ModalProvider } from "@/components/ui/modal";
import { NAV_MODE_COOKIE_NAME, parseNavModeCookie, resolveInitialNavMode } from "@/lib/nav/nav-mode";
import { readSignedInPreferences } from "@/lib/theme/server-prefs";
import { requiresMfaChallengeFailClosed } from "@/lib/auth/mfa";
import { createClient } from "@/lib/supabase/server";
import { getPendingCounts, type PendingCounts } from "@/lib/governance/pending-counts";
import { readOnboardingSeed } from "@/lib/onboarding/seed-server";

/**
 * Governance badge counts for the nav, scoped to the signed-in actor's own
 * workspace (explicit workspace filter + four-eyes exclusion live in
 * getPendingCounts). Fail-soft by contract: any error yields null so a
 * count problem can never break the shell.
 */
async function loadPendingCounts(): Promise<PendingCounts | null> {
  try {
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return null;
    const { data: profile } = await db
      .from("profiles")
      .select("workspace_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile?.workspace_id) return null;
    return await getPendingCounts(db, { userId: user.id, workspaceId: profile.workspace_id });
  } catch {
    return null;
  }
}

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  // R-91 — an MFA-enrolled session that hasn't passed its challenge yet
  // gets bounced to the code step before any console page renders. This is
  // NOT purely a UX convenience: most console pages under (console)/**
  // read their data via direct SSR Postgres queries (their own
  // createClient() + RLS), entirely outside requireAuth (guard.ts)'s
  // fail-closed API gate — so this check is the only enforcement for that
  // surface, and it fails CLOSED (redirects on a lookup error too, not just
  // on an actual unsatisfied challenge) rather than letting the console
  // render on an inconclusive check.
  if (await requiresMfaChallengeFailClosed()) {
    redirect("/login?step=mfa");
  }

  // R-78 — resolve the sidebar's Essentials/all mode before first paint (no
  // flash). `readSignedInPreferences` is React-`cache()`d, so this shares
  // the same DB read root layout.tsx already made for appearance overrides
  // rather than issuing a second one for the same request.
  const store = await cookies();
  const cookieMode = parseNavModeCookie(store.get(NAV_MODE_COOKIE_NAME)?.value);
  const { config, hasRow, isDemo } = await readSignedInPreferences();
  const initialNavMode = resolveInitialNavMode({
    cookie: cookieMode,
    dbMode: config?.nav?.mode,
    hasPrefsRow: hasRow,
    isDemo,
  });

  const pendingCounts = await loadPendingCounts();

  // The viewer's onboarding state, resolved on the server (reuses the cached
  // preferences read above, no extra query) so the page-hint strip is in the
  // first paint instead of popping in after the preferences GET.
  const onboardingSeed = await readOnboardingSeed();

  return (
    <ModalProvider>
      {/* ToastProvider is mounted inside AppShell (wraps the inspector + all console content). */}
      <AppShell initialNavMode={initialNavMode} pendingCounts={pendingCounts} onboardingSeed={onboardingSeed}>
        {children}
      </AppShell>
    </ModalProvider>
  );
}
