import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { cn } from "@/lib/cn";
import {
  APPEARANCE_COOKIE_NAME,
  LEGACY_THEME_COOKIE_NAME,
  parseAppearancePrefs,
  resolveHtmlAttrs,
} from "@/lib/theme/appearance";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const TITLE = "NoPM — agent-operable project governance";
const DESCRIPTION =
  "A lite, API-first project management tool your AI agent can drive. Immutable audit, scoped tokens, maker-checker — governance built into the data layer.";
const SITE_URL = "https://stillnotbald.com";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "NoPM",
    type: "website",
    // No image field: no NoPM-branded asset exists in public/ yet (only
    // Next.js boilerplate svgs) — skip rather than inventing one.
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
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
