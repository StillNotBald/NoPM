import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Idempotency-Key support for create endpoints.
 *
 * A retried POST that carries the same `Idempotency-Key` header replays the
 * stored result instead of creating a second record. Scope of a key is
 * (workspace, actor, route); entries older than 24 hours are ignored and
 * deleted on read. Backed by the server-only `idempotency_keys` table (0067).
 *
 * Known limit: the result is stored AFTER run(), so two truly simultaneous
 * requests with the same key can both run; the loser's insert hits the unique
 * index and it replays the winner's stored result (its own create stays).
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

/** The trimmed `Idempotency-Key` header, or null when absent or malformed. */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("Idempotency-Key");
  if (raw === null) return null;
  const key = raw.trim();
  return KEY_PATTERN.test(key) ? key : null;
}

type StoredRow = { id: string; result: unknown; created_at: string };

export async function withIdempotency<T>(
  args: { workspaceId: string; actorId: string; key: string | null; route: string },
  run: () => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  const key = args.key;
  if (key === null) return { replayed: false, result: await run() };

  const db = createAdminClient();

  const readStored = async (): Promise<StoredRow | null> => {
    const { data } = await db
      .from("idempotency_keys")
      .select("id, result, created_at")
      .eq("workspace_id", args.workspaceId)
      .eq("actor_id", args.actorId)
      .eq("route", args.route)
      .eq("key", key)
      .maybeSingle();
    return (data as StoredRow | null) ?? null;
  };

  const existing = await readStored();
  if (existing) {
    if (!(Date.now() - new Date(existing.created_at).getTime() >= TTL_MS)) {
      return { replayed: true, result: existing.result as T };
    }
    // Expired: drop it so the key can be used again.
    await db.from("idempotency_keys").delete().eq("id", existing.id);
  }

  const result = await run();

  const { error } = await db.from("idempotency_keys").insert({
    workspace_id: args.workspaceId,
    actor_id: args.actorId,
    route: args.route,
    key,
    // Round-trip through JSON so what we replay is exactly what jsonb holds.
    result: JSON.parse(JSON.stringify(result ?? null)),
  });

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // A concurrent request with the same key stored first: replay its result.
      const winner = await readStored();
      if (winner) return { replayed: true, result: winner.result as T };
    }
    // The create already happened; failing to remember it must not fail the request.
    console.warn("idempotency: could not store result", (error as { message?: string }).message);
  }

  return { replayed: false, result };
}
