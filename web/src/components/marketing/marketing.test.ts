/**
 * Guards for the public (Persuade) surfaces: shared CTA, metadata, crawl
 * rules, landmarks, and the proof numbers. Source-inspection + pure-function
 * tests, as elsewhere in this repo (no jsdom: vitest runs `environment: "node"`
 * on `*.test.ts` only).
 *
 * Each block pins a finding from the A5 public-surface audit so it cannot
 * regress silently — notably "the verification layer lags the product": the
 * metadata, the hero copy and the "generated numbers" claim were each right
 * when written and wrong later, with nothing checking them.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { marketingButtonClass } from "./button-link";
import { LANDING_DESCRIPTION, LANDING_TITLE, SITE_URL, pageMetadata } from "./page-metadata";
import { CONSOLE_ROUTES, CRAWL_ALLOW, CRAWL_DISALLOW, PUBLIC_PAGES } from "./crawl-rules";
import metrics from "@/lib/metrics.gen.json";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const ROOT = process.cwd();
// normalise CRLF so the line-based regexes below hold on a Windows checkout (core.autocrlf=true)
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

const LANDING = read("src", "app", "page.tsx");
const CASE_STUDY = read("src", "app", "case-study", "page.tsx");
const LOGIN = read("src", "app", "login", "page.tsx");
const LOGIN_LAYOUT = read("src", "app", "login", "layout.tsx");
const TRANSCRIPT = read("src", "components", "marketing", "transcript.tsx");
const SHELL = read("src", "components", "marketing", "marketing-shell.tsx");
const MOBILE_NAV = read("src", "components", "marketing", "mobile-nav.tsx");
const DEMO_BUTTON = read("src", "components", "demo-login-button.tsx");

// ---------------------------------------------------------------------------
// 1. One CTA definition — and never white text on the accent fill
// ---------------------------------------------------------------------------
describe("marketing CTA — the accent fill pairs with --accent-ink, never white", () => {
  const SOURCES: Record<string, string> = {
    "app/page.tsx": LANDING,
    "app/case-study/page.tsx": CASE_STUDY,
    "app/login/page.tsx": LOGIN,
    "app/not-found.tsx": read("src", "app", "not-found.tsx"),
    "app/error.tsx": read("src", "app", "error.tsx"),
    "app/global-error.tsx": read("src", "app", "global-error.tsx"),
    "components/demo-login-button.tsx": DEMO_BUTTON,
    "components/marketing/button-link.tsx": read("src", "components", "marketing", "button-link.tsx"),
    "components/marketing/wordmark.tsx": read("src", "components", "marketing", "wordmark.tsx"),
    "components/marketing/mobile-nav.tsx": MOBILE_NAV,
    "components/marketing/marketing-shell.tsx": SHELL,
  };

  // In dark mode --accent is #60cdff: white on it is 1.79:1 (axe `color-contrast`, serious).
  it.each(Object.entries(SOURCES))("%s never sets text-white on a bg-accent fill", (_name, src) => {
    for (const line of src.split("\n")) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue; // prose in comments may name the old pair
      const hasAccentFill = /\bbg-accent(?![\w/-])/.test(line);
      if (hasAccentFill) expect(line).not.toMatch(/\btext-white\b/);
    }
  });

  it("the primary variant is bg-accent + text-accent-ink with the shared focus ring and a 44px target", () => {
    const cls = marketingButtonClass({ variant: "primary" });
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("text-accent-ink");
    expect(cls).toContain("focus-ring");
    expect(cls).toContain("min-h-11");
    expect(cls).not.toContain("text-white");
  });

  it("every variant and size keeps the 44px floor below sm and the focus ring", () => {
    for (const variant of ["primary", "secondary", "link"] as const) {
      for (const size of ["md", "sm"] as const) {
        const cls = marketingButtonClass({ variant, size });
        expect(cls).toContain("min-h-11");
        expect(cls).toContain("focus-ring");
      }
    }
  });

  it("block makes a CTA full width below sm so stacked CTAs carry equal weight on a phone", () => {
    expect(marketingButtonClass({ block: true })).toContain("w-full sm:w-auto");
    expect(marketingButtonClass()).not.toContain("w-full");
  });

  it("the demo button reuses the shared class and keeps the zero-JS form post", () => {
    expect(DEMO_BUTTON).toContain("marketingButtonClass");
    expect(DEMO_BUTTON).toMatch(/method="POST"/);
    expect(DEMO_BUTTON).toMatch(/action="\/api\/auth\/demo-login"/);
  });

  it("the demo button shows a pending state and ignores a second submit", () => {
    expect(DEMO_BUTTON).toMatch(/aria-busy=\{pending\}/);
    expect(DEMO_BUTTON).toMatch(/if \(pending\)/);
    expect(DEMO_BUTTON).toMatch(/pageshow/);
  });

  it("the one action has one label on every public page", () => {
    for (const src of [LANDING, CASE_STUDY, LOGIN]) {
      expect(src).not.toMatch(/Open the live demo|Try the shared live demo|Try the demo|Open console/);
    }
    expect(DEMO_BUTTON).toMatch(/label = "Try the live demo"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Metadata — <title> and OG/Twitter are one string; each page has its own URL
// ---------------------------------------------------------------------------
describe("pageMetadata — <title>, og:title and twitter:title cannot fork", () => {
  const m = pageMetadata({ title: "Case study — NoPM", description: "d", path: "/case-study" });

  it("uses the same string for the title, og:title and twitter:title", () => {
    expect(m.title).toEqual({ absolute: "Case study — NoPM" });
    expect(m.openGraph?.title).toBe("Case study — NoPM");
    expect(m.twitter?.title).toBe("Case study — NoPM");
  });

  it("uses the same description everywhere", () => {
    expect(m.description).toBe("d");
    expect(m.openGraph?.description).toBe("d");
    expect(m.twitter?.description).toBe("d");
  });

  it("gives each page its own canonical and og:url (not the root's)", () => {
    expect(m.alternates?.canonical).toBe("/case-study");
    expect((m.openGraph as { url?: string }).url).toBe("/case-study");
  });

  it("is a large-image card by default and indexable", () => {
    expect((m.twitter as { card?: string }).card).toBe("summary_large_image");
    expect(m.robots).toBeUndefined();
  });

  it("noindex pages opt out explicitly", () => {
    const login = pageMetadata({ title: "Sign in — NoPM", description: "d", path: "/login", card: "summary", index: false });
    expect(login.robots).toEqual({ index: false, follow: true });
    expect((login.twitter as { card?: string }).card).toBe("summary");
  });

  it("the landing and the case study build theirs through pageMetadata with their own path", () => {
    expect(LANDING).toMatch(/pageMetadata\(\{[\s\S]*title: LANDING_TITLE[\s\S]*path: "\/"/);
    expect(CASE_STUDY).toMatch(/pageMetadata\(\{[\s\S]*path: "\/case-study"/);
    expect(LOGIN_LAYOUT).toMatch(/pageMetadata\(\{[\s\S]*path: "\/login"[\s\S]*index: false/);
  });

  it("the landing title is the h1 sentence, and the description carries the four-eyes phrase", () => {
    expect(LANDING_TITLE.toLowerCase()).toContain("project governance your ai agent can operate");
    expect(LANDING_DESCRIPTION).toContain("four-eyes");
    expect(LANDING_DESCRIPTION).not.toMatch(/maker-checker/i);
    expect(CASE_STUDY).not.toMatch(/maker-checker approval/i);
  });

  it("each public page with an og:image owns an opengraph-image route (a child's openGraph drops the parent's)", () => {
    expect(existsSync(join(ROOT, "src", "app", "opengraph-image.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "app", "case-study", "opengraph-image.tsx"))).toBe(true);
  });

  it("the OG card's fonts ship with their licenses", () => {
    const dir = join(ROOT, "src", "components", "marketing", "og-fonts");
    for (const f of [
      "InterDisplay-Regular-subset.ttf",
      "Inter-SemiBold-subset.ttf",
      "JetBrainsMono-Regular-subset.ttf",
      "OFL-Inter.txt",
      "OFL-JetBrainsMono.txt",
    ]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Crawl rules — public pages in, API + console out
// ---------------------------------------------------------------------------
describe("robots.txt and sitemap.xml", () => {
  it("every folder under (console) is disallowed — a new console page cannot ship crawlable", () => {
    const dir = join(ROOT, "src", "app", "(console)");
    const folders = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `/${d.name}`);
    expect(folders.length).toBeGreaterThan(10);
    for (const route of folders) {
      expect(CRAWL_DISALLOW).toContain(route);
    }
    // and no stale entries for routes that no longer exist
    for (const route of CONSOLE_ROUTES) {
      expect(folders).toContain(route);
    }
  });

  it("allows the public pages and the two machine-readable surfaces, disallows /api/ and invites", () => {
    expect(CRAWL_ALLOW).toEqual(expect.arrayContaining(["/", "/llms.txt", "/api/openapi.json"]));
    expect(CRAWL_DISALLOW).toEqual(expect.arrayContaining(["/api/", "/invite/"]));
  });

  it("does not disallow /login (it is noindex in its own metadata; a blocked crawler could not read that)", () => {
    expect(CRAWL_DISALLOW).not.toContain("/login");
    expect(LOGIN_LAYOUT).toContain("index: false");
  });

  it("robots() points at the absolute sitemap", () => {
    const r = robots();
    expect(r.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.userAgent).toBe("*");
  });

  it("sitemap() lists exactly the public pages, absolute, with no invented lastModified", () => {
    const entries = sitemap();
    expect(entries.map((e) => e.url)).toEqual([`${SITE_URL}/`, `${SITE_URL}/case-study`]);
    expect(PUBLIC_PAGES).toEqual(["/", "/case-study"]);
    for (const e of entries) expect(e.lastModified).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Landmarks, skip link, headings
// ---------------------------------------------------------------------------
describe("public pages have landmarks and a skip link", () => {
  it("MarketingShell renders one <main id=main> and a skip link that targets it", () => {
    expect(SHELL).toMatch(/<main id="main"/);
    expect(SHELL).toMatch(/href="#main"/);
    expect(SHELL).toMatch(/Skip to content/);
  });

  it.each([
    ["landing", LANDING],
    ["case study", CASE_STUDY],
  ])("the %s page is wrapped in MarketingShell with its own header and footer", (_n, src) => {
    expect(src).toMatch(/<MarketingShell/);
    expect(src).toMatch(/header=\{/);
    expect(src).toMatch(/footer=\{/);
    expect(src).not.toMatch(/<main\b/); // one main, owned by the shell
  });

  it("sign-in renders inside <main> on both steps", () => {
    expect((LOGIN.match(/<main\b/g) ?? []).length).toBeGreaterThanOrEqual(3); // skeleton + form + mfa
  });

  it("the landing's wedge section has its own h2", () => {
    expect(LANDING).toMatch(/<h2[^>]*>[\s\S]*Three properties/);
  });

  it("the h1s do not use the entrance animation (they are the LCP element)", () => {
    const h1Lines = [...LANDING.split("\n"), ...CASE_STUDY.split("\n")].filter((l) => l.includes("<h1 "));
    expect(h1Lines.length).toBe(2);
    for (const l of h1Lines) expect(l).not.toMatch(/\brise\b/);
  });

  it("the mobile menu keeps Tab inside the open sheet and uses the shared focus ring", () => {
    expect(MOBILE_NAV).toMatch(/e\.key !== "Tab"/);
    expect(MOBILE_NAV).toContain("focus-ring");
  });
});

// ---------------------------------------------------------------------------
// 5. Phone: the proof terminal and the review table
// ---------------------------------------------------------------------------
describe("phone layouts", () => {
  it("both pages render the one shared ProofTranscript (no hand-aligned <pre> copies)", () => {
    expect(LANDING).toMatch(/<ProofTranscript/);
    expect(CASE_STUDY).toMatch(/<ProofTranscript/);
    expect(LANDING).not.toMatch(/<pre\b/);
    expect(CASE_STUDY).not.toMatch(/<pre\b/);
  });

  it("the transcript soft-wraps below sm and keeps the full audit row from sm up", () => {
    expect(TRANSCRIPT).toContain("whitespace-pre-wrap");
    expect(TRANSCRIPT).toContain("sm:whitespace-pre");
    expect(TRANSCRIPT).toMatch(/sm:hidden/);
    expect(TRANSCRIPT).toMatch(/hidden sm:inline/);
    // the compact audit row is the real column order minus created_at, within ~39 columns
    const compact = TRANSCRIPT.match(/actor_label {6}action {7}target\n([^\n`]+)/);
    expect(compact).not.toBeNull();
    expect("actor_label      action       target".length).toBeLessThanOrEqual(39);
  });

  it("the closed-defects record is a stacked list below sm and a table from sm up (no 640px scroller)", () => {
    expect(CASE_STUDY).toMatch(/sm:hidden/);
    expect(CASE_STUDY).toMatch(/hidden overflow-x-auto[^"]*sm:block/);
    expect(CASE_STUDY).not.toContain("min-w-[640px]");
    expect(CASE_STUDY).toMatch(/<th scope="col"/);
  });

  it("the stacked tiles do not force a 5-up grid on a phone", () => {
    expect(CASE_STUDY).not.toContain("sm:grid-cols-5");
  });
});

// ---------------------------------------------------------------------------
// 6. Proof numbers come from metrics.gen.json — none typed into the page
// ---------------------------------------------------------------------------
describe("proof numbers are generated, not typed", () => {
  it("every numeric <Metric> on the case study reads from metrics.gen.json", () => {
    // No literal-valued tile: the old `value="1"` / `value="0"` contradicted the
    // "not typed into this page" paragraph that follows.
    expect(CASE_STUDY).not.toMatch(/<Metric\s+value="/);
    const tiles = CASE_STUDY.match(/<Metric\s+value=\{String\(metrics\.\w+\)\}/g) ?? [];
    expect(tiles.length).toBe(3);
  });

  it("every metrics.<key> either page reads exists in metrics.gen.json", () => {
    const keys = new Set<string>();
    for (const src of [LANDING, CASE_STUDY]) {
      // (?<![/\w]) skips the import path, (?!gen\.json) the file name in comments
      for (const m of src.matchAll(/(?<![/\w])metrics\.(?!gen\.json)(\w+)/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const k of keys) expect(Object.keys(metrics)).toContain(k);
  });

  it("the 'generated' claim is limited to counts, and the two invariants are stated as plain text", () => {
    expect(CASE_STUDY).toContain("The three counts above are not typed into this page");
    expect(CASE_STUDY).toContain("One immutable audit row per mutation");
    expect(CASE_STUDY).toContain("No bundled LLM");
  });

  it("no proof count is hand-typed in the landing's captions", () => {
    const captions = LANDING.split("\n").filter((l) => /documented endpoints|runtime dependencies/.test(l));
    expect(captions.length).toBe(2);
    for (const l of captions) expect(l).toMatch(/\{metrics\./);
  });
});

// ---------------------------------------------------------------------------
// 7. The sign-in page explains a failed demo and announces errors
// ---------------------------------------------------------------------------
describe("login page — failure paths", () => {
  it("reads ?error and shows it as an alert with a way out", () => {
    expect(LOGIN).toMatch(/demoLoginErrorMessage\(searchParams\.get\("error"\)\)/);
    expect(LOGIN).toMatch(/role="alert"/);
    expect(LOGIN).toContain("Sign in with your own account");
    expect(LOGIN).toContain('href="/case-study"');
  });

  it("marks the fields invalid and links them to the error message", () => {
    expect(LOGIN).toContain("aria-invalid");
    expect(LOGIN).toContain('aria-describedby={error ? "login-error" : undefined}');
    expect(LOGIN).toContain('id="login-error"');
    expect(LOGIN).toContain('id="mfa-error"');
  });

  it("loads the Supabase client on submit, not on page load (the demo path never needs it)", () => {
    expect(LOGIN).not.toMatch(/from "@\/lib\/supabase\/client"/);
    expect(LOGIN).toMatch(/await import\("@\/lib\/supabase\/client"\)/);
  });

  it("no longer shows a dotted placeholder in the password field", () => {
    expect(LOGIN).not.toContain("••••");
  });
});
