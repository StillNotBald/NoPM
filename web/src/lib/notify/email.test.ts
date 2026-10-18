/**
 * renderNotificationEmail — subject building, CTA construction and HTML-escaping
 * regression guards.
 *
 * The rendered HTML is a demo-mode preview shown in the app, so untrusted
 * notification text (titles/bodies come from user-authored records) must never
 * reach the output as live markup. The escaping assertions below are XSS
 * regression tests, not cosmetics.
 */
import { describe, it, expect } from "vitest";
import { renderNotificationEmail, type NotificationEmailInput } from "./email";

const base = (over: Partial<NotificationEmailInput> = {}): NotificationEmailInput => ({
  type: "approval.requested",
  title: "Deletion approval needed",
  ...over,
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------
describe("renderNotificationEmail — return shape", () => {
  it("returns a subject and an html string", () => {
    const out = renderNotificationEmail(base());
    expect(typeof out.subject).toBe("string");
    expect(typeof out.html).toBe("string");
  });

  it("html is a complete document", () => {
    const { html } = renderNotificationEmail(base());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("is pure — the same input renders identically twice", () => {
    const input = base({ body: "same", payload: { href: "/risks" } });
    expect(renderNotificationEmail(input)).toEqual(renderNotificationEmail(input));
  });

  it("declares itself a demo-mode preview (NoPM never sends email)", () => {
    const { html } = renderNotificationEmail(base());
    expect(html).toContain("Demo-mode preview");
    expect(html).toContain("does not send email");
  });
});

// ---------------------------------------------------------------------------
// Subject — known type prefixes
// ---------------------------------------------------------------------------
describe("buildSubject — known notification types", () => {
  const cases: Array<[string, string]> = [
    ["approval.requested", "Approval needed"],
    ["approval.approved", "Approved"],
    ["approval.rejected", "Rejected"],
    ["risk.escalated", "Risk escalated"],
    ["clash.detected", "Clash detected"],
    ["integration.link_replaced", "Security notice"],
  ];

  for (const [type, prefix] of cases) {
    it(`"${type}" → "${prefix}: <title>"`, () => {
      const { subject } = renderNotificationEmail(base({ type, title: "Bridge deck pour" }));
      expect(subject).toBe(`${prefix}: Bridge deck pour`);
    });
  }

  it("uses the mapped prefix (uppercased) as the header eyebrow label", () => {
    const { html } = renderNotificationEmail(base({ type: "clash.detected" }));
    expect(html).toContain("CLASH DETECTED");
  });
});

// ---------------------------------------------------------------------------
// Subject — unknown type slug humanisation
// ---------------------------------------------------------------------------
describe("buildSubject — unknown type fallback", () => {
  it("humanises a dotted slug: dots become spaces, first letter capitalised", () => {
    const { subject } = renderNotificationEmail(base({ type: "task.assigned", title: "Pour slab" }));
    expect(subject).toBe("Task assigned: Pour slab");
  });

  it("only the FIRST character is uppercased — later words stay lowercase", () => {
    const { subject } = renderNotificationEmail(base({ type: "change.request.raised", title: "T" }));
    expect(subject).toBe("Change request raised: T");
  });

  it("handles a slug with no dot at all", () => {
    const { subject } = renderNotificationEmail(base({ type: "mention", title: "T" }));
    expect(subject).toBe("Mention: T");
  });

  it("leaves underscores untouched (only dots are humanised)", () => {
    const { subject } = renderNotificationEmail(base({ type: "budget_overrun.flagged", title: "T" }));
    expect(subject).toBe("Budget_overrun flagged: T");
  });

  it("handles an empty type without throwing", () => {
    const { subject } = renderNotificationEmail(base({ type: "", title: "T" }));
    expect(subject).toBe(": T");
  });

  it("uppercases the raw type as the eyebrow label for unknown types", () => {
    const { html } = renderNotificationEmail(base({ type: "task.assigned" }));
    expect(html).toContain("TASK.ASSIGNED");
  });

  it("an empty title still yields a well-formed subject", () => {
    const { subject } = renderNotificationEmail(base({ type: "approval.approved", title: "" }));
    expect(subject).toBe("Approved: ");
  });
});

// ---------------------------------------------------------------------------
// CTA URL construction
// ---------------------------------------------------------------------------
describe("CTA URL construction", () => {
  it("defaults to https://stillnotbald.com/dashboard when no payload is given", () => {
    const { html } = renderNotificationEmail(base());
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });

  it("defaults to /dashboard when payload is null", () => {
    const { html } = renderNotificationEmail(base({ payload: null }));
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });

  it("defaults to /dashboard when payload has no href", () => {
    const { html } = renderNotificationEmail(base({ payload: { taskId: "abc" } }));
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });

  it("appends payload.href to the production origin", () => {
    const { html } = renderNotificationEmail(base({ payload: { href: "/risks?risk=r1" } }));
    expect(html).toContain('href="https://stillnotbald.com/risks?risk=r1"');
  });

  it("accepts an entityHref-style deep link with a query param", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: "/change-control?cr=cr-1" } }),
    );
    expect(html).toContain('href="https://stillnotbald.com/change-control?cr=cr-1"');
  });

  it("renders the CTA label", () => {
    const { html } = renderNotificationEmail(base());
    expect(html).toContain("View in NoPM");
  });

  it("always links the footer to the product origin", () => {
    const { html } = renderNotificationEmail(base());
    expect(html).toContain('href="https://stillnotbald.com"');
  });
});

// ---------------------------------------------------------------------------
// Body rendering
// ---------------------------------------------------------------------------
describe("body rendering", () => {
  it("renders a body paragraph when body is present", () => {
    const { html } = renderNotificationEmail(base({ body: "Requested by A. Checker" }));
    expect(html).toContain("Requested by A. Checker");
  });

  it("omits the body paragraph entirely when body is undefined", () => {
    const { html } = renderNotificationEmail(base());
    expect(html).not.toContain("font-size:15px;line-height:1.6");
  });

  it("omits the body paragraph when body is null", () => {
    const { html } = renderNotificationEmail(base({ body: null }));
    expect(html).not.toContain("font-size:15px;line-height:1.6");
  });

  it("omits the body paragraph when body is an empty string (falsy)", () => {
    const { html } = renderNotificationEmail(base({ body: "" }));
    expect(html).not.toContain("font-size:15px;line-height:1.6");
  });

  it("renders the title in the h1", () => {
    const { html } = renderNotificationEmail(base({ title: "Deck pour blocked" }));
    expect(html).toContain(">Deck pour blocked</h1>");
  });
});

// ---------------------------------------------------------------------------
// escapeHtml — XSS regression guards
// ---------------------------------------------------------------------------
describe("escapeHtml — title injection", () => {
  it("escapes a <script> tag in the title (no live script element)", () => {
    const { html } = renderNotificationEmail(base({ title: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an img/onerror payload in the title", () => {
    const { html } = renderNotificationEmail(base({ title: '<img src=x onerror="alert(1)">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("escapes ampersands", () => {
    const { html } = renderNotificationEmail(base({ title: "Piling & Foundations" }));
    expect(html).toContain("Piling &amp; Foundations");
  });

  it("escapes double quotes", () => {
    const { html } = renderNotificationEmail(base({ title: 'The "Gateway" package' }));
    expect(html).toContain("The &quot;Gateway&quot; package");
  });

  it("escapes single quotes as &#39;", () => {
    const { html } = renderNotificationEmail(base({ title: "O'Brien's package" }));
    expect(html).toContain("O&#39;Brien&#39;s package");
  });

  it("escapes & before < so entities are not double-encoded", () => {
    const { html } = renderNotificationEmail(base({ title: "<b>" }));
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("&amp;lt;");
  });

  it("escapes an already-encoded entity's ampersand (no entity smuggling)", () => {
    const { html } = renderNotificationEmail(base({ title: "&lt;script&gt;" }));
    expect(html).toContain("&amp;lt;script&amp;gt;");
    expect(html).not.toContain("<script");
  });

  it("escapes the title inside <title> as well as the h1", () => {
    const { html } = renderNotificationEmail(base({ title: "</title><script>x</script>" }));
    expect(html).not.toContain("<script>");
    // The only closing </title> is the template's own, immediately after the escaped text
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("escapeHtml — body injection", () => {
  it("escapes a <script> tag in the body", () => {
    const { html } = renderNotificationEmail(base({ body: "<script>fetch('/api/tokens')</script>" }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an attribute-breakout attempt in the body", () => {
    const { html } = renderNotificationEmail(base({ body: '"><svg onload=alert(1)>' }));
    expect(html).not.toContain("<svg");
    expect(html).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });

  it("escapes quotes, ampersands and angle brackets together", () => {
    const { html } = renderNotificationEmail(base({ body: `& < > " '` }));
    expect(html).toContain("&amp; &lt; &gt; &quot; &#39;");
  });
});

describe("escapeHtml — type/eyebrow injection", () => {
  it("escapes markup smuggled through an unmapped notification type", () => {
    const { html } = renderNotificationEmail(base({ type: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>");
    // Eyebrow label is the uppercased type, then escaped
    expect(html).toContain("&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;");
  });

  it("escapes the type when it reaches <title> via the subject", () => {
    const { html, subject } = renderNotificationEmail(base({ type: '"><b>x', title: "T" }));
    // subject is plain text and is NOT escaped — escaping happens at render sites
    expect(subject).toBe('"><b>x: T');
    expect(html).not.toContain("<b>x");
    expect(html).toContain("&quot;&gt;&lt;b&gt;x: T");
  });
});

// ---------------------------------------------------------------------------
// payload.href hardening — the CTA href is escaped and restricted to
// same-origin absolute paths; anything else falls back to /dashboard.
// ---------------------------------------------------------------------------
describe("payload.href — escaping and same-origin validation", () => {
  it("escapes quotes in payload.href — no attribute breakout", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: '/x" onmouseover="alert(1)' } }),
    );
    expect(html).not.toContain('href="https://stillnotbald.com/x" onmouseover=');
    expect(html).toContain("href=\"https://stillnotbald.com/x&quot; onmouseover=&quot;alert(1)\"");
  });

  it("escapes angle brackets in payload.href — no live script element", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: '/x"><script>alert(1)</script>' } }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("rejects a full URL in payload.href — falls back to /dashboard", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: "https://evil.example/steal" } }),
    );
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });

  it("rejects a protocol-relative //host path — falls back to /dashboard", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: "//evil.example/steal" } }),
    );
    expect(html).not.toContain("evil.example");
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });

  it("rejects a non-string payload.href — falls back to /dashboard", () => {
    const { html } = renderNotificationEmail(
      base({ payload: { href: 42 as unknown as string } }),
    );
    expect(html).not.toContain("stillnotbald.com42");
    expect(html).toContain('href="https://stillnotbald.com/dashboard"');
  });
});
