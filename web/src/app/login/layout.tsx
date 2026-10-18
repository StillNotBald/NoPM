import type { Metadata } from "next";
import { pageMetadata } from "@/components/marketing/page-metadata";

// The sign-in page is a client component (it can't export metadata), so its
// title lives here. It is a utility page: noindex, and no OG image, so a plain
// "summary" card rather than a large-image card with nothing in it.
export const metadata: Metadata = pageMetadata({
  title: "Sign in — NoPM",
  description: "Sign in to your NoPM workspace, or try the shared live demo.",
  path: "/login",
  card: "summary",
  index: false,
});

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
