/**
 * Test helper (not imported by app code): static-markup accessibility checks
 * for the server-render smoke tests. There is no DOM test environment in this
 * repo, so the tests render components with `react-dom/server` and inspect the
 * HTML — enough to prove a label is wired to its control, which is exactly the
 * defect the UI audit found ("13 of 13 fields unlabeled" on the Risk form).
 */

const CONTROL = /<(input|select|textarea)\b([^>]*)>/g;

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

export interface ControlReport {
  tag: string;
  attrs: string;
  id?: string;
  /** How the control gets its accessible name, or undefined when it has none. */
  namedBy?: "label-for" | "wrapping-label" | "aria-label" | "aria-labelledby";
}

/** Every form control in the markup, with how (or whether) it is named. */
export function controlsIn(markup: string): ControlReport[] {
  const labelFor = new Set<string>();
  for (const m of markup.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) labelFor.add(m[1]);

  const wrapped: Array<[number, number]> = [];
  for (const m of markup.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)) {
    wrapped.push([m.index!, m.index! + m[0].length]);
  }

  const out: ControlReport[] = [];
  for (const m of markup.matchAll(CONTROL)) {
    const attrs = m[2];
    const type = attr(attrs, "type");
    if (type === "hidden" || type === "submit" || type === "button") continue;
    const id = attr(attrs, "id");
    let namedBy: ControlReport["namedBy"];
    if (attr(attrs, "aria-label")) namedBy = "aria-label";
    else if (attr(attrs, "aria-labelledby")) namedBy = "aria-labelledby";
    else if (id && labelFor.has(id)) namedBy = "label-for";
    else if (wrapped.some(([a, b]) => m.index! > a && m.index! < b)) namedBy = "wrapping-label";
    out.push({ tag: m[1], attrs, id, namedBy });
  }
  return out;
}

/** Controls with no accessible name. Empty means every control is labelled. */
export function unnamedControls(markup: string): ControlReport[] {
  return controlsIn(markup).filter((c) => !c.namedBy);
}

/** `<label for="x">` whose target id does not exist in the markup. */
export function danglingLabels(markup: string): string[] {
  const missing: string[] = [];
  for (const m of markup.matchAll(/<label\b[^>]*\sfor="([^"]+)"/g)) {
    if (!markup.includes(`id="${m[1]}"`)) missing.push(m[1]);
  }
  return missing;
}
