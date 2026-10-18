import type { Metadata } from "next";

/**
 * One source for every public page's title/description/OG/Twitter text, so the
 * `<title>`, `og:title`, `twitter:title` and the descriptions cannot fork
 * (they did: root layout said "agent-operable project governance" and
 * "maker-checker", the landing said "project governance your AI agent can
 * operate" and "four-eyes"). Public copy says "four-eyes" everywhere;
 * "maker-checker" stays the internal/contributor term.
 *
 * Next replaces — not merges — a page's `openGraph` object, and a parent
 * segment's file-based image is dropped when a child sets its own `openGraph`.
 * So every public page builds its metadata through `pageMetadata()` and keeps
 * an `opengraph-image.tsx` next to its `page.tsx`.
 */

export const SITE_URL = "https://stillnotbald.com";
export const SITE_NAME = "NoPM";

export const LANDING_TITLE = "NoPM — project governance your AI agent can operate";
export const LANDING_DESCRIPTION =
  "A lite, API-first project-management tool your AI agent drives like the aws/supabase CLIs. Immutable audit, scoped tokens, four-eyes approval — enforced in the data layer.";

type PageMetadataInput = {
  /** The exact document title (not run through the root `%s — NoPM` template). */
  title: string;
  description: string;
  /** Site-relative path, e.g. "/case-study". Resolved against `metadataBase`. */
  path: string;
  /** `summary_large_image` needs an og:image — pages without one pass "summary". */
  card?: "summary_large_image" | "summary";
  /** false = `noindex` (sign-in and other pages nobody should land on from search). */
  index?: boolean;
};

export function pageMetadata({
  title,
  description,
  path,
  card = "summary_large_image",
  index = true,
}: PageMetadataInput): Metadata {
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    ...(index ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
    },
    twitter: { card, title, description },
  };
}
