import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { compareAnchor, NOT_ANCHORED, unreachableStatus, type AnchorStatus } from "./compare";
import { readLiveHashAt, readLiveHead, type LiveHead } from "./live";
import { getReceipt, saveReceipt, type Db, type Receipt } from "./receipts";
import { safeAnchorError, type AnchorRecord, type AnchorSink, type LatestResult } from "./sink";

/**
 * Anchoring the audit chain head outside the database (R-168..R-170, owner decision Q8).
 *
 * Order everywhere (PR-13): verify first, record the verify result, THEN anchor the head that
 * includes the verify row. Nothing is anchored while the state is mismatch or the verification
 * failed. "Anchored" is never reported unless a comparison against the sink actually ran.
 *
 * Failure mode (D8): a failed put never blocks a business write, the verify route or the cron tick.
 * It records status=failed with the streak start, and writes ONE audit.anchor_failed row per
 * streak; the next success clears the streak. A mismatch is recorded the same way, with ONE
 * audit.anchor_mismatch row per streak. Successful anchoring writes no audit row except
 * audit.anchored for the first anchor of a workspace and for the first success after a failure.
 */
export type AnchorCtx = {
  db: Db;
  sink: AnchorSink;
  workspaceId: string;
  /** Who the audit rows are attributed to: the session user (verify route) or the system actor (cron). */
  actor: Actor;
  now?: Date;
};

export type Evaluation = {
  status: AnchorStatus;
  /** The newest record in the sink for this workspace, or null (never anchored, no sink, or unreadable). */
  latest: AnchorRecord | null;
  /** The live row_hash at the anchored chain_seq when it was read. */
  liveHashAtAnchor: string | null;
};

const iso = (ctx: AnchorCtx) => (ctx.now ?? new Date()).toISOString();

/** Compare the live chain with the newest anchor. Never throws on the sink; a live-database read error is rethrown. */
export async function evaluateAnchor(ctx: Pick<AnchorCtx, "db" | "sink" | "workspaceId">, preloaded?: LatestResult, liveHead?: LiveHead | null): Promise<Evaluation> {
  if (ctx.sink.kind === "none") return { status: { ...NOT_ANCHORED }, latest: null, liveHashAtAnchor: null };
  const res = preloaded ?? (await ctx.sink.latest([ctx.workspaceId]));
  if (!res.ok) return { status: unreachableStatus(res.error), latest: null, liveHashAtAnchor: null };
  const latest = res.records.get(ctx.workspaceId) ?? null;
  if (!latest) return { status: { ...NOT_ANCHORED }, latest: null, liveHashAtAnchor: null };
  const head = liveHead === undefined ? await readLiveHead(ctx.db, ctx.workspaceId) : liveHead;
  const hashAt = head && head.seq === latest.chain_seq ? head.hash : head && head.seq > latest.chain_seq ? await readLiveHashAt(ctx.db, ctx.workspaceId, latest.chain_seq) : null;
  return { status: compareAnchor(latest, { headSeq: head?.seq ?? null, hashAtAnchorSeq: hashAt }), latest, liveHashAtAnchor: hashAt };
}

type BadStatus = "failed" | "mismatch";

/**
 * Remember a failure or mismatch. Writes the audit row only when this is a NEW streak (the receipt
 * did not already carry this status), and only then saves the receipt, so a failed audit write is
 * retried next time instead of being silently forgotten. Returns the streak start.
 */
export async function recordBad(
  ctx: AnchorCtx,
  status: BadStatus,
  reason: string,
  detail: Record<string, unknown> = {},
  receipt?: Receipt | null,
): Promise<string> {
  const prev = receipt === undefined ? await getReceipt(ctx.db, ctx.workspaceId) : receipt;
  const now = iso(ctx);
  if (prev && prev.status === status) {
    // Same streak: refresh the message only; no new audit row.
    if (prev.error_text !== reason) await saveReceipt(ctx.db, ctx.workspaceId, { error_text: reason });
    return prev.streak_started_at ?? now;
  }
  const input = {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    targetType: "audit_log",
    targetId: null,
    before: null,
    after: { reason, streak_started_at: now, ...detail },
  };
  try {
    if (status === "failed") await writeAudit({ ...input, action: "audit.anchor_failed" });
    else await writeAudit({ ...input, action: "audit.anchor_mismatch" });
  } catch (err) {
    console.error(`[anchor] audit.anchor_${status === "failed" ? "failed" : "mismatch"} audit write failed:`, safeAnchorError(err));
    return now; // receipt not saved: the next run opens the streak again and retries the row
  }
  await saveReceipt(ctx.db, ctx.workspaceId, { status, error_text: reason, streak_started_at: now });
  return now;
}

/** Fold an evaluation into the receipt and the audit trail; returns the status with `since` filled in. */
export async function recordEvaluation(ctx: AnchorCtx, ev: Evaluation): Promise<AnchorStatus> {
  const { status } = ev;
  if (status.state === "mismatch") {
    const since = await recordBad(ctx, "mismatch", status.reason ?? "the live chain differs from the anchor", {
      anchored_chain_seq: status.chain_seq,
      anchored_hash: ev.latest?.head_hash ?? null,
      live_hash_at_anchored_seq: ev.liveHashAtAnchor,
    });
    return { ...status, since };
  }
  if (status.state === "unreachable") {
    const since = await recordBad(ctx, "failed", status.reason ?? "the anchor database could not be read");
    return { ...status, since };
  }
  if ((status.state === "anchored" || status.state === "behind") && ev.latest) {
    // A sound comparison clears an older failure or mismatch streak (for instance after the owner
    // recorded a fresh anchor by hand); keep the display receipt current without churning it.
    const prev = await getReceipt(ctx.db, ctx.workspaceId);
    // A failure streak is cleared only by a successful put (anchorHead), which announces the recovery.
    if (prev?.status === "failed") return status;
    // A mismatch (including "the chain did not verify") is cleared only by a NEWER anchor than the one
    // known when it was recorded, for instance one the owner recorded by hand after investigating.
    if (prev?.status === "mismatch") {
      const newer = prev.chain_seq !== null && ev.latest.chain_seq > prev.chain_seq;
      const resetSince = !!ev.latest.baseline_reset_at && !!prev.streak_started_at && ev.latest.baseline_reset_at > prev.streak_started_at;
      if (!newer && !resetSince) return status;
    }
    if (!prev || prev.status !== "anchored" || prev.chain_seq !== ev.latest.chain_seq || prev.reset_at !== (ev.latest.baseline_reset_at ?? null)) {
      await saveReceipt(ctx.db, ctx.workspaceId, {
        status: "anchored",
        chain_seq: ev.latest.chain_seq,
        head_hash: ev.latest.head_hash,
        row_count: ev.latest.row_count,
        anchored_at: ev.latest.anchored_at,
        error_text: null,
        streak_started_at: null,
        reset_at: ev.latest.baseline_reset_at ?? null,
      });
    }
  }
  return status;
}

export type AnchorOutcome =
  | { outcome: "anchored"; status: AnchorStatus; announced: boolean }
  | { outcome: "skipped"; status: AnchorStatus }
  | { outcome: "mismatch"; status: AnchorStatus }
  | { outcome: "failed"; status: AnchorStatus }
  | { outcome: "disabled" | "empty"; status: AnchorStatus };

/**
 * Put the CURRENT head of the workspace into the sink and read it back.
 *  - `latest` is what the sink holds now (from evaluateAnchor): a head already anchored is skipped,
 *    and `latest === null` means the first anchor, which is announced by one audit.anchored row after it succeeds.
 *  - The caller must already have established that the chain verified ok and the state is not mismatch.
 *  - Never throws on the sink; a live-database read error is rethrown.
 */
export async function anchorHead(ctx: AnchorCtx, latest: AnchorRecord | null): Promise<AnchorOutcome> {
  if (ctx.sink.kind === "none") return { outcome: "disabled", status: { ...NOT_ANCHORED } };

  const prev = await getReceipt(ctx.db, ctx.workspaceId);
  const first = latest === null;
  const recovery = prev?.status === "failed";

  const head = await readLiveHead(ctx.db, ctx.workspaceId);
  if (!head) return { outcome: "empty", status: { ...NOT_ANCHORED } };

  if (latest && latest.chain_seq === head.seq && latest.head_hash === head.hash) {
    if (prev && prev.status !== "anchored") {
      await saveReceipt(ctx.db, ctx.workspaceId, {
        status: "anchored", chain_seq: latest.chain_seq, head_hash: latest.head_hash, row_count: latest.row_count,
        anchored_at: latest.anchored_at, error_text: null, streak_started_at: null,
      });
    }
    return {
      outcome: "skipped",
      status: { ...NOT_ANCHORED, state: "anchored", chain_seq: latest.chain_seq, anchored_at: latest.anchored_at, row_count: latest.row_count },
    };
  }

  const record: AnchorRecord = {
    workspace_id: ctx.workspaceId,
    chain_seq: head.seq,
    head_hash: head.hash,
    // The chain is gapless and 1-based (0104), so the number of rows up to the head equals its chain_seq.
    row_count: head.seq,
    anchored_at: iso(ctx),
  };
  const put = await ctx.sink.put(record);

  if (put.status === "stored" || put.status === "exists") {
    // The first anchor of a workspace, and the first success after a failure streak, are announced by
    // ONE audit row, written only AFTER the sink confirmed (so a sink that keeps failing cannot flood
    // the trail). The row itself is covered by the next anchor.
    let announced = false;
    if (first || recovery) {
      try {
        await writeAudit({
          workspaceId: ctx.workspaceId,
          actor: ctx.actor,
          action: "audit.anchored",
          targetType: "audit_log",
          targetId: null,
          before: null,
          after: {
            reason: first ? "first_anchor" : "recovered",
            chain_seq: put.record.chain_seq,
            head_hash: put.record.head_hash,
            previous_chain_seq: latest?.chain_seq ?? null,
          },
        });
        announced = true;
      } catch (err) {
        console.error("[anchor] audit.anchored write failed:", safeAnchorError(err));
      }
    }
    await saveReceipt(ctx.db, ctx.workspaceId, {
      status: "anchored",
      chain_seq: put.record.chain_seq,
      head_hash: put.record.head_hash,
      row_count: put.record.row_count,
      anchored_at: put.record.anchored_at,
      error_text: null,
      streak_started_at: null,
    });
    return {
      outcome: "anchored",
      announced,
      status: { ...NOT_ANCHORED, state: "anchored", chain_seq: put.record.chain_seq, anchored_at: put.record.anchored_at, row_count: put.record.row_count },
    };
  }

  if (put.status === "conflict") {
    const reason = `the anchor database already holds a different hash for row ${record.chain_seq}`;
    const since = await recordBad(ctx, "mismatch", reason, {
      anchored_chain_seq: record.chain_seq,
      anchored_hash: put.stored.head_hash,
      live_hash_at_anchored_seq: record.head_hash,
    }, prev);
    return {
      outcome: "mismatch",
      status: { state: "mismatch", chain_seq: put.stored.chain_seq, anchored_at: put.stored.anchored_at, row_count: put.stored.row_count, rows_behind: null, since, reason, reset_at: latest?.baseline_reset_at ?? null },
    };
  }

  if (put.status === "failed") {
    const since = await recordBad(ctx, "failed", put.error, { chain_seq: record.chain_seq }, prev);
    return { outcome: "failed", status: unreachableStatus(put.error, since, latest ? { ...NOT_ANCHORED, chain_seq: latest.chain_seq, anchored_at: latest.anchored_at, row_count: latest.row_count } : null) };
  }

  return { outcome: "disabled", status: { ...NOT_ANCHORED } };
}

/**
 * Read-only anchor state for a document (the audit pack). Records nothing, writes nothing, never
 * throws: an unreadable sink or database reads as `unreachable`, an unset variable as `not_anchored`.
 */
export async function peekAnchor(db: Db, sink: AnchorSink, workspaceId: string): Promise<AnchorStatus> {
  try {
    return (await evaluateAnchor({ db, sink, workspaceId })).status;
  } catch (err) {
    return unreachableStatus(safeAnchorError(err));
  }
}

/**
 * Recompute the chain over the newest `limit` rows (the database function of migration 0104, read only).
 * The cron verifies only the rows since the last anchor, so `limit` is "rows since the anchor plus the link row".
 */
export async function verifyWindow(db: Db, workspaceId: string, limit: number): Promise<{ ok: boolean; firstBadId: string | null; firstSeq: number | null }> {
  const { data, error } = await db.rpc("nopm_audit_verify_chain", { p_workspace_id: workspaceId, p_from: null, p_limit: limit });
  if (error) throw new Error(`chain verification failed to run: ${error.message}`);
  const res = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; first_bad_id?: string | null; first_seq?: number | string | null } | undefined;
  return { ok: res?.ok === true, firstBadId: res?.first_bad_id ?? null, firstSeq: res?.first_seq == null ? null : Number(res.first_seq) };
}

/**
 * May a head be anchored on the strength of a verified window? Only when the window reached back to
 * the previous anchor (the anchored row is then checked against the live chain by the comparison and
 * everything after it by the window) or to row 1 (the whole chain). A partial check such as
 * `?limit=1` must not put "anchored" on a chain nobody checked end to end (W2-04).
 */
export function windowCoversAnchor(firstSeq: number | null, previousAnchorSeq: number | null): boolean {
  if (firstSeq === null) return false;
  if (firstSeq <= 1) return true;
  return previousAnchorSeq !== null && firstSeq <= previousAnchorSeq;
}
