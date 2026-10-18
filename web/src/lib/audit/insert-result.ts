import type { AuditedRow } from "@/lib/audit/audited-write";

/**
 * Adapter between auditedInsert (throws) and insertWithReference (expects { data, error }).
 * A unique violation (SQLSTATE 23505) comes back as an error so the caller takes the next reference
 * number and retries; every other failure is rethrown untouched, so no audit row exists for a row
 * that was not written.
 */
export async function asInsertResult(
  write: Promise<AuditedRow>,
): Promise<{ data: AuditedRow | null; error: { code?: string; message: string } | null }> {
  try {
    return { data: await write, error: null };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown } | null;
    if (err && err.code === "23505") {
      return { data: null, error: { code: "23505", message: typeof err.message === "string" ? err.message : "duplicate" } };
    }
    throw e;
  }
}
