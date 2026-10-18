import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { cn } from "@/lib/cn";
import {
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  SITE_NAME,
  SITE_URL,
} from "@/components/marketing/page-metadata";
import {
  APPEARANCE_COOKIE_NAME,
  LEGACY_THEME_COOKIE_NAME,
  parseAppearancePrefs,
  resolveHtmlAttrs,
  mergeAppearanceWithDb,
} from "@/lib/theme/appearance";
import { readSignedInAppearanceOverride } from "@/lib/theme/server-prefs";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Absolute URLs (canonical, og:url, og:image) resolve against this.
  metadataBase: new URL(SITE_URL),
  // Console pages set a bare `metadata.title`; the template appends the brand
  // once. The public pages (landing, case study, sign-in) pass an absolute
  // title through `pageMetadata()` so <title>, og:title and twitter:title are
  // the same string. This default is the landing's, so a page that sets
  // nothing still unfurls with the one phrase of the thesis.
  title: { default: LANDING_TITLE, template: "%s — NoPM" },
  description: LANDING_DESCRIPTION,
  applicationName: SITE_NAME,
  // No `url` here on purpose: each public page declares its own og:url, and a
  // root-level one would be wrong for every other route. The og:image is the
  // file-based `opengraph-image.tsx` next to each public page.
  openGraph: {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await cookies();
  const appearanceRaw = store.get(APPEARANCE_COOKIE_NAME)?.value;
  let prefs = parseAppearancePrefs(appearanceRaw);
  if (!appearanceRaw) {
    // No new-format cookie yet — fall back to the legacy `theme` cookie so
    // existing sessions keep rendering exactly what they rendered before
    // this change (light default unless they'd explicitly toggled dark).
    const legacyDark = store.get(LEGACY_THEME_COOKIE_NAME)?.value === "dark";
    if (legacyDark) prefs = { ...prefs, mode: "dark" };
  }
  // L-39 follow-through: for a signed-in NON-demo user, density/dateDisplay
  // persisted to user_preferences win over the cookie (cross-device account
  // state) — see mergeAppearanceWithDb's docstring for why mode/fontScale
  // are excluded and why the demo identity is exempt. Fails soft to the
  // cookie value alone on any error (anonymous visitor, demo, Supabase
  // hiccup) — never blocks first paint.
  const dbOverride = await readSignedInAppearanceOverride();
  prefs = mergeAppearanceWithDb(prefs, dbOverride, { isDemo: false });
  const { classNames, style } = resolveHtmlAttrs(prefs);
  return (
    <html
      lang="en"
      className={cn(`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`, ...classNames)}
      style={style}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
