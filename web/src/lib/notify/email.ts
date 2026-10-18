/**
 * renderNotificationEmail — pure function, no sending.
 * Returns a branded HTML email and subject line for any notification type.
 * Resend is demo-mode; this is for preview rendering only.
 *
 * Mail clients drop CSS variables, <style> and media queries, so the colours
 * are literal hex written inline. They are the product's LIGHT-theme tokens
 * from globals.css (white card, near-black ink, Fluent-blue accent, the fixed
 * dark terminal bar) — email-palette.test.ts pins every value to its token so
 * this template cannot drift to a different brand again (it was a warm palette
 * after the 2026-08-13 retheme, with a low-contrast CTA at 3.12:1).
 */

/** Literal hex per role → the globals.css token it mirrors (light theme). */
export const EMAIL_PALETTE = {
  /** page backdrop — --np-well */
  backdrop: "#F0F0F2",
  /** card surface — --np-surface */
  surface: "#FFFFFF",
  /** hairlines — --np-rule */
  border: "#E5E5E8",
  /** title — --np-fg */
  ink: "#161616",
  /** body copy — --np-fg-2 */
  inkSecondary: "#555559",
  /** footer / fine print — --np-fg-3 */
  inkMuted: "#6A6A70",
  /** CTA fill + brand blue — --accent (white text on it: 4.53:1) */
  accent: "#0078D4",
  /** text on the accent — --accent-ink */
  accentInk: "#FFFFFF",
  /** header bar, the product's fixed-dark terminal window — --terminal-surface */
  terminal: "#0A0A0B",
  /** wordmark on the terminal bar — white */
  terminalInk: "#FFFFFF",
  /** type label on the terminal bar — --terminal-text-muted (~7.5:1) */
  terminalMuted: "#A1A1AA",
  /** traffic-light dots — --terminal-red / -amber / -green */
  dotRed: "#FF5F57",
  dotAmber: "#FEBC2E",
  dotGreen: "#28C840",
} as const;

const P = EMAIL_PALETTE;

export type NotificationEmailInput = {
  type: string;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
};

/** Per-type subject prefix map. */
const TYPE_SUBJECT_PREFIXES: Record<string, string> = {
  "approval.requested": "Approval needed",
  "approval.approved": "Approved",
  "approval.rejected": "Rejected",
  "risk.escalated": "Risk escalated",
  "clash.detected": "Clash detected",
  // A chat account link was replaced: a security notice, not a feature event.
  "integration.link_replaced": "Security notice",
  "item.stale": "Needs an update",
  "report.weekly": "Weekly report",
};

function buildSubject(type: string, title: string): string {
  const prefix = TYPE_SUBJECT_PREFIXES[type];
  if (prefix) return `${prefix}: ${title}`;
  // Fallback: humanise the type slug (e.g. "foo.bar" → "Foo bar: ...")
  const humanised = type
    .replace(/\./g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
  return `${humanised}: ${title}`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderNotificationEmail(n: NotificationEmailInput): RenderedEmail {
  const subject = buildSubject(n.type, n.title);
  // Only same-origin absolute paths may drive the CTA; anything else falls back.
  const rawHref = typeof n.payload?.href === "string" ? n.payload.href : "/dashboard";
  const ctaPath = rawHref.startsWith("/") && !rawHref.startsWith("//") ? rawHref : "/dashboard";
  const ctaUrl = `https://stillnotbald.com${ctaPath}`;

  const bodyHtml = n.body
    ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${P.inkSecondary}">${escapeHtml(n.body)}</p>`
    : "";

  const typeLabel = TYPE_SUBJECT_PREFIXES[n.type]
    ? TYPE_SUBJECT_PREFIXES[n.type].toUpperCase()
    : n.type.toUpperCase();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${P.backdrop};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${P.backdrop};padding:40px 16px;">
    <tr>
      <td align="center">
        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${P.surface};border-radius:10px;border:1px solid ${P.border};overflow:hidden;">

          <!-- Terminal-window header bar: traffic lights, wordmark, type label -->
          <tr>
            <td style="background-color:${P.terminal};padding:16px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="display:inline-block;width:10px;height:10px;border-radius:5px;background-color:${P.dotRed};margin-right:6px;"></span><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background-color:${P.dotAmber};margin-right:6px;"></span><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background-color:${P.dotGreen};margin-right:12px;"></span><span style="font-family:ui-monospace,'Cascadia Code','Fira Code',monospace;font-size:16px;font-weight:700;color:${P.terminalInk};letter-spacing:-0.01em;">nopm</span>
                  </td>
                  <td align="right">
                    <span style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${P.terminalMuted};">${escapeHtml(typeLabel)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 28px 24px;">
              <!-- Title -->
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3;color:${P.ink};letter-spacing:-0.01em;">${escapeHtml(n.title)}</h1>

              <!-- Body text -->
              ${bodyHtml}

              <!-- CTA button -->
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:${P.accent};">
                    <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:${P.accentInk};text-decoration:none;border-radius:6px;letter-spacing:0.01em;">View in NoPM &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 28px;">
              <hr style="border:none;border-top:1px solid ${P.border};margin:0;" />
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 28px 24px;">
              <p style="margin:0;font-size:11px;line-height:1.5;color:${P.inkMuted};">
                <strong style="color:${P.ink};">Demo-mode preview</strong> &mdash; NoPM does not send email. Resend runs in demo-mode; this shows exactly what would be delivered. &middot; <a href="https://stillnotbald.com" style="color:${P.inkMuted};text-decoration:underline;">stillnotbald.com</a>
              </p>
            </td>
          </tr>

        </table>
        <!-- End card -->
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
