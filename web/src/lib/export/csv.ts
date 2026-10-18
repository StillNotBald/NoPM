/**
 * Minimal RFC 4180 CSV writer (L-27).
 *
 * Deliberately dependency-free (no new npm deps): a field is quoted only
 * when it contains a comma, a double quote, or a line break — embedded
 * quotes are escaped by doubling ("" ). Rows are joined with CRLF per the
 * RFC. The header row is ALWAYS emitted, even for zero data rows, so a
 * caller piping the output into a spreadsheet always gets consistent
 * columns. A UTF-8 BOM is prefixed so Excel opens the file without mangling
 * non-ASCII text.
 */

const CRLF = "\r\n";
const BOM = "﻿";

/** Stringify + quote a single CSV field per RFC 4180, with formula-injection
 * neutralization (CWE-1236): a field starting with = + - @ or a tab/CR would
 * execute as a formula/DDE payload when the export is opened in Excel/Sheets.
 * User-writable free text (risk titles, task names, notes) flows into exports
 * verbatim, so any such leading character gets a `'` prefix — the standard
 * spreadsheet neutralizer. Numbers pass through the typeof check unprefixed,
 * so numeric columns (including negatives) stay numeric. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  let str = typeof value === "string" ? value : JSON.stringify(value);

  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Render one row (array of raw values) to a CSV line (no trailing CRLF). */
export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}

/**
 * Build a full RFC 4180 CSV document (with BOM) from a header + rows.
 * The header row is always written, even when `rows` is empty.
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [csvRow(header), ...rows.map((row) => csvRow(row))];
  return BOM + lines.join(CRLF) + CRLF;
}
