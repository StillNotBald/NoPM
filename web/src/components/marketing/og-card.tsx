import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The link-unfurl image for the public pages, drawn in the product's own
 * world: white canvas, the Fluent-blue N mark, and the dark terminal window
 * with the proof transcript. No stock imagery, no gradients, no shadows.
 *
 * Used by `app/opengraph-image.tsx` and `app/case-study/opengraph-image.tsx`
 * (Next drops a parent's file-based image when a page sets its own `openGraph`,
 * so each public page keeps its own file). Both are statically generated at
 * build time, so the font files below are read once at build, not per request.
 *
 * Fonts: ImageResponse cannot use next/font, so the faces are small ASCII
 * subsets in ./og-fonts (Inter for prose, JetBrains Mono for the transcript;
 * both SIL OFL, licenses alongside). If a font file is ever missing the card
 * still renders with the built-in face rather than failing the build.
 *
 * Hex values mirror globals.css tokens (OG renderers cannot read CSS
 * variables): --accent, --text-primary/-secondary/-muted, --terminal-*.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";

const COLOR = {
  canvas: "#ffffff",
  ink: "#161616",
  inkSecondary: "#555559",
  inkMuted: "#6a6a70",
  accent: "#0078d4",
  accentInk: "#ffffff",
  terminalSurface: "#0a0a0b",
  terminalBorder: "#26262b",
  terminalText: "rgba(255, 255, 255, 0.82)",
  terminalMuted: "#a1a1aa",
  terminalRed: "#ff5f57",
  terminalAmber: "#febc2e",
  terminalGreen: "#28c840",
  terminalGreenInk: "#4ade80",
} as const;

const FONT_DIR = join(process.cwd(), "src", "components", "marketing", "og-fonts");

type OgFont = { name: string; data: Buffer; weight: 400 | 600; style: "normal" };

async function loadFonts(): Promise<OgFont[] | undefined> {
  try {
    const [display, semibold, mono] = await Promise.all([
      readFile(join(FONT_DIR, "InterDisplay-Regular-subset.ttf")),
      readFile(join(FONT_DIR, "Inter-SemiBold-subset.ttf")),
      readFile(join(FONT_DIR, "JetBrainsMono-Regular-subset.ttf")),
    ]);
    return [
      { name: "Inter", data: display, weight: 400, style: "normal" },
      { name: "Inter", data: semibold, weight: 600, style: "normal" },
      { name: "JetBrains Mono", data: mono, weight: 400, style: "normal" },
    ];
  } catch {
    return undefined;
  }
}

/** One transcript row: [text, tone]. A null row is a half-height gap. */
type Row = readonly [text: string, tone?: "muted" | "ok"] | null;

// Lines are the landing's transcript (components/marketing/transcript.tsx),
// re-broken for the card's ~34 columns. "…" marks what the card trims.
const TRANSCRIPT: readonly Row[] = [
  ["$ nopm tasks rm task_8f3a \\"],
  ['    --reason "superseded by…"'],
  ["delete requested — pending a"],
  ["checker's approval (four-eyes)"],
  null,
  ["$ nopm approve req_2c91"],
  ["✓ approved & committed", "ok"],
  ["  # a different token", "muted"],
  ["  # one immutable audit row", "muted"],
  null,
  ["$ nopm audit --limit 1"],
  ["checker (agent)  task.delete"],
];

export async function renderOgCard({
  headline,
  sub,
  label,
  headlineSize = 62,
}: {
  headline: string;
  sub?: string;
  /** Mono eyebrow above the headline (the case study's "Portfolio case study"). */
  label?: string;
  headlineSize?: number;
}) {
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          background: COLOR.canvas,
          color: COLOR.ink,
          padding: 64,
          fontFamily: "Inter",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: 520,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 56,
                height: 56,
                borderRadius: 14,
                background: COLOR.accent,
                color: COLOR.accentInk,
                fontSize: 34,
                fontWeight: 600,
              }}
            >
              N
            </div>
            <div style={{ marginLeft: 16, fontSize: 34, fontWeight: 600 }}>NoPM</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            {label ? (
              <div
                style={{
                  display: "flex",
                  marginBottom: 22,
                  fontFamily: "JetBrains Mono",
                  fontSize: 19,
                  letterSpacing: 3,
                  textTransform: "uppercase",
                  color: COLOR.accent,
                }}
              >
                {label}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                fontSize: headlineSize,
                lineHeight: 1.08,
                letterSpacing: -1.5,
                color: COLOR.ink,
              }}
            >
              {headline}
            </div>
            {sub ? (
              <div
                style={{
                  display: "flex",
                  marginTop: 26,
                  fontSize: 25,
                  lineHeight: 1.4,
                  color: COLOR.inkSecondary,
                }}
              >
                {sub}
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", fontFamily: "JetBrains Mono", fontSize: 22, color: COLOR.inkMuted }}>
            stillnotbald.com
          </div>
        </div>

        <div style={{ display: "flex", flex: 1, alignItems: "center", marginLeft: 56 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              width: "100%",
              background: COLOR.terminalSurface,
              border: `1px solid ${COLOR.terminalBorder}`,
              borderRadius: 14,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "16px 22px",
                borderBottom: `1px solid ${COLOR.terminalBorder}`,
              }}
            >
              <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, background: COLOR.terminalRed }} />
              <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, marginLeft: 8, background: COLOR.terminalAmber }} />
              <div style={{ display: "flex", width: 14, height: 14, borderRadius: 7, marginLeft: 8, background: COLOR.terminalGreen }} />
              <div style={{ display: "flex", marginLeft: 14, fontFamily: "JetBrains Mono", fontSize: 17, color: COLOR.terminalMuted }}>
                an agent drives NoPM
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                padding: "24px 26px 26px",
                fontFamily: "JetBrains Mono",
                fontSize: 20,
                lineHeight: 1.5,
                whiteSpace: "pre",
              }}
            >
              {TRANSCRIPT.map((row, i) =>
                row === null ? (
                  <div key={i} style={{ display: "flex", height: 14 }} />
                ) : (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      color:
                        row[1] === "muted"
                          ? COLOR.terminalMuted
                          : row[1] === "ok"
                            ? COLOR.terminalGreenInk
                            : COLOR.terminalText,
                    }}
                  >
                    {row[0]}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE, ...(fonts ? { fonts } : {}) },
  );
}
