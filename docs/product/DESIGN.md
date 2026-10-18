---
name: NoPM
description: terminal-light — governed project management with a terminal heart, Fluent-blue accent
colors:
  canvas: "#ffffff"
  well: "#f0f0f2"
  border-subtle: "#e5e5e8"
  border-strong: "#d2d2d6"
  ink: "#161616"
  ink-secondary: "#555559"
  ink-muted: "#6a6a70"
  accent-blue: "#0078d4"
  accent-blue-hover: "#106ebe"
  terminal-surface: "#0a0a0b"
  status-info: "#2563eb"
  status-success: "#16a34a"
  status-warning: "#f59e0b"
  status-sev-high: "#ea580c"
  status-danger: "#e5484d"
  status-change: "#7c3aed"
  info-ink: "#1d4ed8"
  success-ink: "#166534"
  warning-ink: "#92400e"
  sev-high-ink: "#9a3412"
  danger-ink: "#b42318"
  change-ink: "#5b21b6"
  accent-ink: "#ffffff"
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
    backgroundColor: "{colors.accent-blue}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.accent-blue-hover}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  badge-neutral:
    backgroundColor: "{colors.well}"
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

NoPM looks like the tool of an engineer who runs a tight ship: a white, light-first workspace with a dark terminal beating at its center. The operating surfaces are calm, dense, and typographically quiet — near-black ink on white, one rationed blue accent — while the terminal motif (traffic-light chrome, mono transcripts, the `$ nopm` prompt) carries the brand's proof moments: this product is operated by commands and audited by rows, and the UI is honest about that. Dark mode is not a skin but the terminal turned inside-out: near-black canvas, GitHub-dark status hues.

Restraint is the personality. Color means status, never decoration; monospace means data, command, or measurement, never costume; the blue appears where an action or a live signal earns it. The system rejects gradients, glassmorphism, decorative shadows, and marketing exuberance.

**Key Characteristics:**
- Light-first white canvas with a component-scoped fixed-dark terminal surface (#0a0a0b) in BOTH themes
- One brand accent (Fluent blue #0078d4 — owner retheme 2026-08-13, was terminal green); status hues never leak into branding
- SF/Inter for prose, SF Mono/JetBrains Mono for anything technical
- Hairline borders (#e5e5e8) do the separating; shadows are reserved for overlays; no blur anywhere
- Density tuned for operators: 14px body, tight tables, generous section separation

## Colors

A white-and-ink field where color is a signal, not a surface.

### Primary
- **Fluent Blue** (#0078d4, hover #106ebe): the single brand accent — primary buttons, live indicators, section eyebrows, the solid focus ring, selection tint. On fills it carries `text-accent-ink` (white in light mode); dark mode swaps the fill to a brighter #60cdff and the ink to near-black. Never hard-code `text-white` on `bg-accent`: it is 1.8:1 in dark mode.

### Neutral
- **Canvas White** (#ffffff): page and card background.
- **Well Gray** (#f0f0f2): hover states, insets, sidebar, neutral pills — the only "second surface" in light mode.
- **Hairline** (#e5e5e8) / **Hairline Strong** (#d2d2d6): borders and dividers; strong is for interactive affordances (secondary-button borders, hovered cards).
- **Ink** (#161616) / **Ink Secondary** (#555559) / **Ink Muted** (#6a6a70, 5.4:1 on white): the three-step text hierarchy.
- **Terminal Surface** (#0a0a0b): the fixed-dark terminal-window background, identical in both themes; white text at 40-80% alpha lives on it.

### Status (functional, never brand)
- **Info Blue** (#2563eb): in-progress states. (Deliberately deeper than the brand blue; appears only in tint-pills, never as a fill, so the two blues do not compete.)
- **Success Green** (#16a34a): completed/healthy — status, not action.
- **Warning Amber** (#f59e0b): at-risk, over-allocation.
- **Severity Orange** (#ea580c): "high" severity — the step between warning and danger.
- **Danger Red** (#e5484d): critical/urgent, destructive actions.
- **Change Violet** (#7c3aed): change-control artifacts in review.

Dark theme swaps every value to its GitHub-dark counterpart (defined in `web/src/app/globals.css`); status hues keep their meanings exactly.

**The Ink Rule (status text).** A saturated status hue fails 4.5:1 as text on white (warning 2.2:1, danger 3.9:1, sev-high 3.6:1). So the raw hue (`bg-warning`, `bg-danger/15`, `border-danger/30`, `ring-*`) is for FILLS, TINTS, BORDERS and ICON GLYPHS only; every piece of status TEXT uses the `-ink` companion: `text-info-ink`, `text-success-ink`, `text-warning-ink`, `text-sev-high-ink`, `text-danger-ink`, `text-change-ink`. Each ink clears 4.5:1 on white and on its own 15% tint, in both themes. `<Badge>` has a tone for every hue and already pairs them.

**The One Blue Rule.** Fluent blue is the only color allowed to mean "NoPM." Status hues appear only on the state they name, in tint-plus-ink-text pills (15% background alpha), never as fills or decoration.

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
- **Label** (500, text-xs / 11px mono, tracking-tight): badges, pills, eyebrows (uppercase tracking-widest for section labels), timestamps, refs. 11px is the floor at every width: `text-2xs` is 11px (it used to shrink to 10px from `sm` up; never write `text-[10px]`).

**The Mono-Means-Data Rule.** Monospace is reserved for code, commands, identifiers, scopes, and measured values. Prose never sets in mono; data never sets in prose type.

## Layout

Max-width containers (max-w-4xl case study, max-w-5xl landing) with px-6 gutters; the console is a sidebar shell (collapsible, push-margin) + sticky 56px header + content region. Spacing rhythm follows Tailwind steps — tight within groups (gap-2/3), generous between sections (py-8–12); marketing sections separate with hairline `<Rule/>` dividers rather than background shifts. Mobile (390px) is first-class: bottom-nav, horizontal-scroll Kanban, 44px touch targets (every `<Button>` and `<IconButton>` floors at 44px below `sm`/`lg` and keeps its compact desktop height).

## Elevation & Depth

Flat by default: hairline borders, not shadows, define structure. The shadow vocabulary exists but is rationed to floating layers.

### Shadow Vocabulary
- **shadow-sm** (`0 1px 2px rgba(0,0,0,0.04)`): barely-there lift on interactive cards.
- **shadow-md** (`0 4px 16px rgba(0,0,0,0.08)`): toasts and small inline dropdowns.
- **shadow-lg** (`0 12px 32px rgba(0,0,0,0.12)`): anything that floats over the page: popovers, menus, the command palette, modals, sheets and the right push panel.

**The Flat-By-Default Rule.** Surfaces at rest are flat and bordered. Shadow is a statement of layering (something floats above the page), never decoration. `shadow-xl` / `shadow-2xl` are not in the vocabulary.

**The No-Blur Rule.** No `backdrop-blur` anywhere: sticky chrome (header, breadcrumbs, bottom nav) is a solid `bg-canvas`; scrims are flat `bg-black/30`. Beyond taste there is a bug behind it: a `backdrop-filter` makes its element the containing block for every `position: fixed` descendant, which once pushed the notification sheet 171px above the viewport.

**The Overlay Rule.** An overlay that covers the page (modal, sheet, dialog) renders OUTSIDE `[data-app-shell]`: `Modal`, `RightPushPanel`, `AssistantPanel` and `CommandPalette` are siblings of the shell; anything opened from inside the shell goes through `<Portal>` (`ui/portal.tsx`) into `document.body`. Below `lg` the shell is made `inert` while one is open, so an overlay inside it would inert itself. A closed panel is `inert` + `invisible` (never just translated off-screen), so nothing in it is focusable and its shadow cannot smear into the viewport edge.

## Shapes

Small, precise radii: 5px (sm) for tight controls, 8px (md) as the default for buttons/inputs/cards, 11px (lg) for large buttons, 14px (xl) for modal sheets, bottom sheets and terminal cards (`rounded-xl` / `rounded-t-xl`, never `2xl`). Status pills are full-round. No sharp-corner brutalism, no pill-shaped buttons — the geometry reads "macOS window," not "web app trend."

## Components

### Buttons
- **Shape:** rounded-md (8px); lg size steps to 11px.
- **Primary:** Fluent-blue fill, `text-accent-ink`, semibold; hover deepens to #106ebe.
- **Secondary:** white surface, hairline border, ink text; hover fills well gray.
- **Ghost:** ink-secondary text, hover well; **Danger:** danger fill, white text.
- **Focus:** the `focus-ring` utility (see Focus below). **Disabled:** 50% opacity, pointer-events none.
- Sizes: h-8 / h-10 / h-12 on desktop; `sm` and `md` also carry `max-sm:min-h-11` (a min-height floor, so a caller's own `h-9` cannot shrink the phone touch target).
- `<ButtonLink>` is the same recipe on a `next/link`; `<IconButton label>` is the icon-only form (44px below `lg`, 40px at `lg`+; `label` is required and becomes the `aria-label`).
- Overriding a class is safe: `cn()` is tailwind-merge (configured for this system's tokens), so `className="text-danger-ink"` really replaces the variant's text colour.

### Badges (status pills)
- Full-round, **mono** font, tracking-tight; sm (11px) for dense rows, md (12px) default.
- Tones: neutral = well/ink-secondary; every status tone (info, success, warning, sev-high, danger, change) = 15%-alpha tint + the hue's `-ink` text. `accent` is the one solid fill (brand/attention counts, never a status).

### Cards / Containers
- White surface (or well for emphasis wells like Wedges/Metrics), hairline border, rounded-lg, p-5/6. No resting shadow.

### Inputs
- h-10 (h-11 on mobile), rounded-md, hairline border, canvas background; focus = `focus-ring` + accent border; placeholder in ink-muted. `<Select>` and `<Textarea>` are the same field style; wrap any of them in `<Field label error hint>` so the label, hint and error are wired by `useId` (a bare sibling `<label>` names nothing).

### Terminal Card (signature)
- `<TerminalCard>`: rounded-xl, fixed #0a0a0b surface in both themes, chrome bar with macOS traffic lights (`<TrafficLights>`) + mono white/40 title, mono transcript body in white/80 at 12-13px. The brand's proof-moment container — audit trails, CLI demos, the app header motif.

### Navigation
- Console sidebar: grouped IA, well hover, accent indicators; sticky header with traffic-light motif + breadcrumbs; mobile bottom-nav. Marketing nav: text links in ink-secondary hovering to ink, one accent CTA.
- **Owner-approved exception (2026-09-05):** the ACTIVE sidebar item carries a 2px accent left bar (`border-l-2 border-accent`; inactive items are `border-transparent`). It is the only colored border-left in the product; do not copy it to cards, callouts or list rows.
- First tab stop on every console page is a "Skip to content" link targeting `<main id="main-content" tabIndex={-1}>`.
- Keyboard shortcuts: the only global binding is Cmd/Ctrl+K (command palette); Escape closes the top-most overlay. The shortcuts dialog lists exactly those, plus the palette's arrow keys and Enter; never list a shortcut that has no handler.

### Focus
- One strength everywhere: the `focus-ring` utility, a solid 2px `--accent` outline with a 2px offset (4.5:1 on light, 11:1 on dark; paints on `:focus-visible` only). `focus-ring-inset` draws it inside the box for rows, cells and menu items inside a clipping container.
- Do not pair it with `focus:outline-none`, and do not use `ring-*` for focus (an `accent/30` ring measured 1.5:1). `focus:outline-none` is acceptable only on a non-interactive element that is a programmatic focus target (`<main tabIndex={-1}>`, a dialog container, a moved-to heading) or on a text input whose row shows `focus-within:border-accent`.

### Borders
- `* { border-color: var(--np-rule) }` lives in `@layer base`, so every Tailwind border-colour utility (`border-accent`, `border-danger/30`, `border-border-strong`, `focus-visible:border-accent`) overrides it. An UNLAYERED rule beats all of `@layer utilities` regardless of specificity, which once turned about 85 colour utilities into no-ops (toast borders, danger callouts, the sidebar accent bar). Keep new base rules in `@layer base`; only intentional "nothing may beat this" rules (density, print) stay unlayered.

## Do's and Don'ts

### Do:
- **Do** use semantic tokens (`text-ink`, `bg-well`, `text-warning-ink`, `text-sev-high-ink`, `text-change-ink`) — every color in the system has a token; raw hexes in `web/src` are limited to the terminal chrome's fixed values inside `terminal-card.tsx`.
- **Do** give every status pill the tint+text treatment (`bg-<tone>/15 text-<tone>-ink`), which survives both themes.
- **Do** keep the terminal surface #0a0a0b fixed in both themes — the terminal being dark IS the brand.
- **Do** set anything machine-ish (IDs, scopes, counts, commands, timestamps) in mono.
- **Do** verify dark mode for every new surface; status hues swap to the GitHub-dark ramp automatically if tokens are used.

### Don't:
- **Don't** introduce gradients, glass/blur decoration, or colored border-left accents — the system's rejection list is absolute (the sidebar's active bar is the single owner-approved exception, above).
- **Don't** use the brand blue for status ("in progress" has its own deeper blue, #2563eb) or any status hue for branding. A solid `bg-accent` pill is not a status.
- **Don't** put a saturated status hue (`text-warning`, `text-danger`, `text-success`, `text-sev-high`) on text, or `text-white` on `bg-accent`: use the `-ink` token / `text-accent-ink`.
- **Don't** hardcode Tailwind palette classes (`amber-50`, `indigo-500`) — they broke dark mode once already.
- **Don't** add resting shadows to cards or emoji as icons.
- **Don't** exceed the three-step ink hierarchy for text — a fourth gray means the hierarchy is failing.
