import { cookies } from "next/headers";
import { AppShell } from "@/components/layout/app-shell";
import { ModalProvider } from "@/components/ui/modal";
import { NAV_MODE_COOKIE_NAME, parseNavModeCookie, resolveInitialNavMode } from "@/lib/nav/nav-mode";
import { readSignedInPreferences } from "@/lib/theme/server-prefs";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
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

  return (
    <ModalProvider>
      {/* ToastProvider is mounted inside AppShell (wraps the inspector + all console content). */}
      <AppShell initialNavMode={initialNavMode}>{children}</AppShell>
    </ModalProvider>
  );
}
