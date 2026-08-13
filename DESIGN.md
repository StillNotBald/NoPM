---
name: NoPM
description: macOS-terminal-light — governed project management with a terminal heart
colors:
  canvas: "#ffffff"
  sunken: "#f0f0f2"
  border-subtle: "#e5e5e8"
  border-strong: "#d2d2d6"
  ink: "#161616"
  ink-secondary: "#555559"
  ink-muted: "#8b8b90"
  terminal-green: "#00a600"
  terminal-green-hover: "#009100"
  terminal-surface: "#0e0e0f"
  status-info: "#2563eb"
  status-success: "#16a34a"
  status-warning: "#f59e0b"
  status-sev-high: "#ea580c"
  status-danger: "#e5484d"
  status-change: "#7c3aed"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.875rem, 4vw, 3rem)"
    fontWeight: 400
    lineHeight: 1.1
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "-0.01em"
rounded:
  sm: "5px"
  md: "8px"
  lg: "11px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.terminal-green}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.terminal-green-hover}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  badge-neutral:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink-secondary}"
    rounded: "999px"
    padding: "2px 8px"
  input-default:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
---

# Design System: NoPM

## Overview

**Creative North Star: "The Governed Terminal"**

NoPM looks like the tool of an engineer who runs a tight ship: a white, light-first macOS workspace with a dark terminal beating at its center. The operating surfaces are calm, dense, and typographically quiet — near-black ink on white, one rationed green accent — while the terminal motif (traffic-light chrome, mono transcripts, the `$ nopm` prompt) carries the brand's proof moments: this product is operated by commands and audited by rows, and the UI is honest about that. Dark mode is not a skin but the terminal turned inside-out: near-black canvas, GitHub-dark status hues.

Restraint is the personality. Color means status, never decoration; monospace means data, command, or measurement, never costume; the green appears where an action or a live signal earns it. The system rejects gradients, glassmorphism, decorative shadows, and marketing exuberance.

**Key Characteristics:**
- Light-first white canvas with a component-scoped fixed-dark terminal surface (#0e0e0f) in BOTH themes
- One brand accent (terminal green #00a600); five functional status hues that never leak into branding
- SF/Inter for prose, SF Mono/JetBrains Mono for anything technical
- Hairline borders (#e5e5e8) do the separating; shadows are reserved for overlays
- Density tuned for operators: 14px body, tight tables, generous section separation

## Colors

A white-and-ink field where color is a signal, not a surface.

### Primary
- **Terminal Green** (#00a600, hover #009100): the single brand accent — primary buttons, live indicators, section eyebrows, focus rings (at 30-40% alpha), selection tint. On fills it carries white text in light mode; dark mode swaps to a brighter #00c24a with near-black text.

### Neutral
- **Canvas White** (#ffffff): page and card background.
- **Sunken Gray** (#f0f0f2): hover states, insets, sidebar, neutral pills — the only "second surface" in light mode.
- **Hairline** (#e5e5e8) / **Hairline Strong** (#d2d2d6): borders and dividers; strong is for interactive affordances (secondary-button borders, focused input borders).
- **Ink** (#161616) / **Ink Secondary** (#555559) / **Ink Muted** (#8b8b90): the three-step text hierarchy.
- **Terminal Surface** (#0e0e0f): the fixed-dark terminal-window background, identical in both themes; white text at 40-80% alpha lives on it.

### Status (functional, never brand)
- **Info Blue** (#2563eb): in-progress states.
- **Success Green** (#16a34a): completed/healthy (distinct from the brand green — status, not action).
- **Warning Amber** (#f59e0b): at-risk, over-allocation.
- **Severity Orange** (#ea580c): "high" severity — the step between warning and danger.
- **Danger Red** (#e5484d): critical/urgent, destructive actions.
- **Change Violet** (#7c3aed): change-control artifacts in review.

Dark theme swaps every value to its GitHub-dark counterpart (defined in `web/src/app/globals.css`); status hues keep their meanings exactly.

**The One Green Rule.** Terminal green is the only color allowed to mean "NoPM." Status hues appear only on the state they name, in tint-plus-saturated-text pills (15% background alpha), never as fills or decoration.

## Typography

**Display Font:** SF Pro Display (Inter fallback) — the `--font-display` token; a sans, used only for the two marketing h1s.
**Body Font:** SF Pro Text (Inter fallback)
**Label/Mono Font:** SF Mono → JetBrains Mono

**Character:** quiet Apple-system neutrality for prose, with monospace as the voice of truth — IDs, scopes, statuses, commands, and metrics are always mono.

### Hierarchy
- **Display** (400, text-3xl–5xl clamp, 1.1): marketing h1 only.
- **Headline** (600, text-xl, ~1.4): section headings in marketing and console pages.
- **Title** (600, text-sm–base): card titles, table headers, form labels.
- **Body** (400, text-sm / 14px, leading-relaxed): the console's default reading size; marketing lede steps up to text-lg.
- **Label** (500, text-xs / 11px mono, tracking-tight): badges, pills, eyebrows (uppercase tracking-widest for section labels), timestamps, refs.

**The Mono-Means-Data Rule.** Monospace is reserved for code, commands, identifiers, scopes, and measured values. Prose never sets in mono; data never sets in prose type.

## Layout

Max-width containers (max-w-4xl case study, max-w-5xl landing) with px-6 gutters; the console is a sidebar shell (collapsible, push-margin) + sticky 56px header + content region. Spacing rhythm follows Tailwind steps — tight within groups (gap-2/3), generous between sections (py-8–12); marketing sections separate with hairline `<Rule/>` dividers rather than background shifts. Mobile (390px) is first-class: bottom-nav, horizontal-scroll Kanban, 44px touch targets.

## Elevation & Depth

Flat by default: hairline borders, not shadows, define structure. The shadow vocabulary exists but is rationed to floating layers.

### Shadow Vocabulary
- **shadow-sm** (`0 1px 2px rgba(0,0,0,0.04)`): barely-there lift on interactive cards.
- **shadow-md** (`0 4px 16px rgba(0,0,0,0.08)`): dropdowns, popovers, command palette.
- **shadow-lg** (`0 12px 32px rgba(0,0,0,0.12)`): modals and the right push panel.

**The Flat-By-Default Rule.** Surfaces at rest are flat and bordered. Shadow is a statement of layering (something floats above the page), never decoration.

## Shapes

Small, precise radii: 5px (sm) for tight controls, 8px (md) as the default for buttons/inputs/cards, 11px (lg) for large buttons, 14px (xl) for modal sheets and terminal cards (rounded-xl). Status pills are full-round. No sharp-corner brutalism, no pill-shaped buttons — the geometry reads "macOS window," not "web app trend."

## Components

### Buttons
- **Shape:** rounded-md (8px); lg size steps to 11px.
- **Primary:** terminal-green fill, white text, semibold; hover deepens to #009100.
- **Secondary:** white surface, hairline border, ink text; hover fills sunken gray.
- **Ghost:** ink-secondary text, hover sunken; **Danger:** danger fill, white text.
- **Focus:** 2px ring at accent/40. **Disabled:** 50% opacity, pointer-events none.
- Sizes: h-8 / h-10 / h-12.

### Badges (status pills)
- Full-round, **mono** font, tracking-tight; sm (11px) for dense rows, md (12px) default.
- Tones: neutral = sunken/ink-secondary; all status tones = 15%-alpha tint + saturated text of the same hue.

### Cards / Containers
- White surface (or sunken for emphasis wells like Wedges/Metrics), hairline border, rounded-lg, p-5/6. No resting shadow.

### Inputs
- h-10 (h-11 on mobile), rounded-md, hairline border, canvas background; focus = border-strong + 2px accent/30 ring; placeholder in ink-muted.

### Terminal Card (signature)
- `<TerminalCard>`: rounded-xl, fixed #0e0e0f surface in both themes, chrome bar with macOS traffic lights (`<TrafficLights>`) + mono white/40 title, mono transcript body in white/80 at 12-13px. The brand's proof-moment container — audit trails, CLI demos, the app header motif.

### Navigation
- Console sidebar: grouped IA, sunken hover, accent indicators; sticky header with traffic-light motif + breadcrumbs; mobile bottom-nav. Marketing nav: text links in ink-secondary hovering to ink, one accent CTA.

## Do's and Don'ts

### Do:
- **Do** use semantic tokens (`text-ink`, `bg-sunken`, `text-warning`, `text-sev-high`, `text-change`) — every color in the system has a token; raw hexes in `web/src` are limited to the terminal chrome's fixed values inside `terminal-card.tsx`.
- **Do** give every status pill the tint+text treatment (`bg-<tone>/10-15 text-<tone>`), which survives both themes.
- **Do** keep the terminal surface #0e0e0f fixed in both themes — the terminal being dark IS the brand.
- **Do** set anything machine-ish (IDs, scopes, counts, commands, timestamps) in mono.
- **Do** verify dark mode for every new surface; status hues swap to the GitHub-dark ramp automatically if tokens are used.

### Don't:
- **Don't** introduce gradients, glass/blur decoration, or colored border-left accents — the system's rejection list is absolute.
- **Don't** use terminal green for status ("success" has its own green, #16a34a) or any status hue for branding.
- **Don't** hardcode Tailwind palette classes (`amber-50`, `indigo-500`) — they broke dark mode once already.
- **Don't** add resting shadows to cards or emoji as icons.
- **Don't** exceed the three-step ink hierarchy for text — a fourth gray means the hierarchy is failing.
