/** Keep only the named columns of a row returned by the audited-write wrapper (the RPC returns the whole row, including hashes and ciphertext that a response or audit payload must never carry). */
export function pickColumns<T extends string>(row: Record<string, unknown>, columns: readonly T[]): Record<T, unknown> {
  const out = {} as Record<T, unknown>;
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

/** "a, b, c" (a Supabase select string) to ["a","b","c"]. */
export function columnsOf(select: string): string[] {
  return select.split(",").map((c) => c.trim()).filter(Boolean);
}
