/**
 * renderNotificationEmail — pure function, no sending.
 * Returns a branded HTML email and subject line for any notification type.
 * Resend is demo-mode; this is for preview rendering only.
 */

const BRAND_CREAM = "#FAF9F5";
const BRAND_CORAL = "#D97757";
const BRAND_INK = "#1C1B18";
const BRAND_INK_MUTED = "#6B6860";
const BRAND_SURFACE = "#FFFFFF";
const BRAND_BORDER = "#E8E6DF";

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
  const ctaPath = (n.payload?.href as string | undefined) ?? "/dashboard";
  const ctaUrl = `https://stillnotbald.com${ctaPath}`;

  const bodyHtml = n.body
    ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${BRAND_INK_MUTED}">${escapeHtml(n.body)}</p>`
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
<body style="margin:0;padding:0;background-color:${BRAND_CREAM};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND_CREAM};padding:40px 16px;">
    <tr>
      <td align="center">
        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:${BRAND_SURFACE};border-radius:10px;border:1px solid ${BRAND_BORDER};overflow:hidden;">

          <!-- Coral header bar -->
          <tr>
            <td style="background-color:${BRAND_CORAL};padding:18px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="font-family:ui-monospace,'Cascadia Code','Fira Code',monospace;font-size:16px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">nopm</span>
                  </td>
                  <td align="right">
                    <span style="font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.75);">${escapeHtml(typeLabel)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 28px 24px;">
              <!-- Title -->
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;line-height:1.3;color:${BRAND_INK};letter-spacing:-0.01em;">${escapeHtml(n.title)}</h1>

              <!-- Body text -->
              ${bodyHtml}

              <!-- CTA button -->
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:6px;background-color:${BRAND_CORAL};">
                    <a href="${ctaUrl}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;letter-spacing:0.01em;">View in NoPM &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding:0 28px;">
              <hr style="border:none;border-top:1px solid ${BRAND_BORDER};margin:0;" />
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 28px 24px;">
              <p style="margin:0;font-size:11px;line-height:1.5;color:${BRAND_INK_MUTED};">
                <strong style="color:${BRAND_CORAL};">Demo-mode preview</strong> &mdash; NoPM does not send email. Resend runs in demo-mode; this shows exactly what would be delivered. &middot; <a href="https://stillnotbald.com" style="color:${BRAND_INK_MUTED};text-decoration:underline;">stillnotbald.com</a>
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
