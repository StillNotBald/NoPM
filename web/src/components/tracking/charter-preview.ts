/**
 * A readable teaser of the charter body. Heading lines are dropped (the title
 * is already shown above, and flattening them into the text produced run-ons
 * like "Customer Data Platform Purpose Authorises the…"); list markers, bold,
 * code ticks and link syntax are stripped; the remaining prose is joined.
 */
export function bodyPreview(body: string | null, maxLen = 200): string | null {
  if (!body || body.trim() === "") return null;
  const text = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
  if (text === "") return null;
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}
