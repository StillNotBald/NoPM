import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError, ConflictError, RuleError } from "@/lib/api/errors";

/**
 * Idempotency-Key support for create endpoints.
 *
 * A retried POST that carries the same `Idempotency-Key` header replays the
 * stored result instead of creating a second record. Scope of a key is
 * (workspace, actor, route); entries older than 24 hours are ignored and
 * deleted on read. Backed by the server-only `idempotency_keys` table
 * (0067, reserve-before-run columns in 0074).
 *
 * The key is RESERVED before run(): a 'pending' row is inserted and the unique
 * index picks one winner. The loser replays a finished row, or gets 409 while
 * the winner is still working. If run() throws the reservation is deleted so a
 * retry can run; a pending row older than STALE_PENDING_MS is taken over.
 * Passing `bodyHash` (see `hashRequestBody`) makes a reused key with a
 * different body a 422.
 */

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const TTL_MS = 24 * 60 * 60 * 1000;
const STALE_PENDING_MS = 2 * 60 * 1000;

/**
 * The trimmed `Idempotency-Key` header, or null when the header is absent.
 * A header that is present but empty/malformed is a 400 (R-11): silently
 * ignoring it would leave the caller believing a retry is safe.
 */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("Idempotency-Key");
  if (raw === null) return null;
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(
      400,
      "Idempotency-Key must be 1-200 characters of letters, digits, and _ . : -",
      "invalid_idempotency_key",
    );
  }
  return key;
}

/** Stable SHA-256 of a parsed request body, for the same-key-different-body check. */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

type StoredRow = {
  id: string;
  status: string | null;
  result: unknown;
  created_at: string;
  request_hash: string | null;
};

const age = (iso: string): number => Date.now() - new Date(iso).getTime();

const inProgress = () =>
  new ConflictError("A request with this Idempotency-Key is still in progress", "idempotency_in_progress");

export async function withIdempotency<T>(
  args: { workspaceId: string; actorId: string; key: string | null; route: string; bodyHash?: string | null },
  run: () => Promise<T>,
): Promise<{ replayed: boolean; result: T }> {
  const key = args.key;
  if (key === null) return { replayed: false, result: await run() };

  const db = createAdminClient();
  const bodyHash = args.bodyHash ?? null;

  const readStored = async (): Promise<StoredRow | null> => {
    const { data } = await db
      .from("idempotency_keys")
      .select("id, status, result, created_at, request_hash")
      .eq("workspace_id", args.workspaceId)
      .eq("actor_id", args.actorId)
      .eq("route", args.route)
      .eq("key", key)
      .maybeSingle();
    return (data as StoredRow | null) ?? null;
  };

  const dropRow = async (id: string) => {
    await db.from("idempotency_keys").delete().eq("id", id).eq("workspace_id", args.workspaceId);
  };

  // 1. Reserve the key.
  let rowId: string | null = null;
  for (let attempt = 0; attempt < 3 && rowId === null; attempt++) {
    const ins = await db
      .from("idempotency_keys")
      .insert({
        workspace_id: args.workspaceId,
        actor_id: args.actorId,
        route: args.route,
        key,
        status: "pending",
        result: null,
        request_hash: bodyHash,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (!ins.error) {
      rowId = (ins.data as { id?: string } | null)?.id ?? "";
      break;
    }
    if ((ins.error as { code?: string }).code !== "23505") {
      // Could not reserve (store unavailable): run unprotected rather than fail the create.
      console.warn("idempotency: could not reserve key", (ins.error as { message?: string }).message);
      return { replayed: false, result: await run() };
    }

    // 2. Lost the race (or this is a retry): look at what the winner left.
    const existing = await readStored();
    if (!existing) continue; // vanished between insert and read: try again
    if (age(existing.created_at) >= TTL_MS) {
      await dropRow(existing.id);
      continue;
    }
    if (bodyHash && existing.request_hash && existing.request_hash !== bodyHash) {
      throw new RuleError("Idempotency-Key reused with a different request", "idempotency_key_reused");
    }
    if ((existing.status ?? "done") === "done") {
      return { replayed: true, result: existing.result as T };
    }
    if (age(existing.created_at) < STALE_PENDING_MS) throw inProgress();

    // Stale pending (its worker likely died): take over, compare-and-swap on created_at.
    const take = await db
      .from("idempotency_keys")
      .update({ created_at: new Date().toISOString(), request_hash: bodyHash })
      .eq("id", existing.id)
      .eq("workspace_id", args.workspaceId)
      .eq("status", "pending")
      .eq("created_at", existing.created_at)
      .select("id");
    if (take.error || !Array.isArray(take.data) || take.data.length === 0) throw inProgress();
    rowId = existing.id;
  }

  if (rowId === null) throw inProgress();

  // 3. Run, then record.
  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (rowId) {
      try {
        await dropRow(rowId);
      } catch {
        /* best effort: a stale pending row is taken over after 2 minutes */
      }
    }
    throw err;
  }

  if (rowId) {
    const { error } = await db
      .from("idempotency_keys")
      .update({
        status: "done",
        // Round-trip through JSON so what we replay is exactly what jsonb holds.
        result: JSON.parse(JSON.stringify(result ?? null)),
      })
      .eq("id", rowId)
      .eq("workspace_id", args.workspaceId);
    // The create already happened; failing to remember it must not fail the request.
    if (error) console.warn("idempotency: could not store result", (error as { message?: string }).message);
  }

  return { replayed: false, result };
}
