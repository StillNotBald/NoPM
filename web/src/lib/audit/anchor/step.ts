import { createAdminClient } from "@/lib/supabase/admin";
import { systemActor } from "@/lib/audit/write";
import { sanitizeError } from "@/lib/integrations/secrets";
import { anchorHead, evaluateAnchor, recordBad, recordEvaluation, verifyWindow, type AnchorCtx } from "./anchor";
import { getAnchorSink } from "./get-sink";
import { readLiveHead } from "./live";
import { safeAnchorError, type AnchorSink } from "./sink";

/**
 * The daily anchor step of the scheduler tick (R-168, D11). A SYSTEM job like the nudge step: it
 * walks every workspace and, for each one, verifies ONLY the rows since its last anchor and anchors
 * the head when that check is ok.
 *
 *   - NOPM_ANCHOR_DB_URL unset: returns immediately, no query at all.
 *   - One connection to the anchor database to read the newest anchor of every workspace, then one
 *     short connection per put. After the FIRST failed put the remaining workspaces are marked
 *     failed without further attempts (PR-18), so an unreachable anchor database costs one timeout,
 *     not one per workspace.
 *   - A step budget of 8 s inside the 40 s cron deadline: a workspace not reached keeps its old
 *     anchor and is picked up tomorrow.
 *   - A chain that does not verify, or a live chain that differs from its anchor, is never anchored:
 *     it is recorded as mismatch (one audit.anchor_mismatch row per streak).
 */
export const ANCHOR_STEP_BUDGET_MS = 8_000;
const PAGE = 200;
const VERIFY_MAX_LIMIT = 200_000;
const VERIFY_DEFAULT_LIMIT = 50_000;

export type AnchorStepSummary = {
  /** False when NOPM_ANCHOR_DB_URL is unset: the step did nothing. */
  configured: boolean;
  workspaces: number;
  anchored: number;
  /** Head already anchored, nothing to do. */
  skipped: number;
  mismatched: number;
  failed: number;
  skippedForDeadline: number;
};

export const EMPTY_ANCHOR_STEP: AnchorStepSummary = {
  configured: false,
  workspaces: 0,
  anchored: 0,
  skipped: 0,
  mismatched: 0,
  failed: 0,
  skippedForDeadline: 0,
};

export async function runAnchorStep(
  now: Date,
  deadline: number,
  opts: { sink?: AnchorSink; budgetMs?: number } = {},
): Promise<AnchorStepSummary> {
  const sink = opts.sink ?? getAnchorSink();
  if (sink.kind === "none") return { ...EMPTY_ANCHOR_STEP };
  const summary: AnchorStepSummary = { ...EMPTY_ANCHOR_STEP, configured: true };
  const stepDeadline = Math.min(deadline, Date.now() + (opts.budgetMs ?? ANCHOR_STEP_BUDGET_MS));
  const db = createAdminClient();

  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    let q = db.from("workspaces").select("id").order("id", { ascending: true }).limit(PAGE);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) {
      console.error("[anchor] workspace listing failed:", sanitizeError(error));
      summary.failed += 1;
      return summary;
    }
    const page = (data ?? []) as { id: string }[];
    ids.push(...page.map((w) => w.id));
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  summary.workspaces = ids.length;
  if (ids.length === 0) return summary;

  const latest = await sink.latest(ids);
  let sinkDown = !latest.ok;
  let downReason = latest.ok ? "" : latest.error;

  for (const workspaceId of ids) {
    const ctx: AnchorCtx = { db, sink, workspaceId, actor: systemActor(workspaceId, "anchor"), now };
    if (Date.now() >= stepDeadline) {
      summary.skippedForDeadline += 1;
      continue;
    }
    try {
      if (sinkDown) {
        await recordBad(ctx, "failed", downReason || "the anchor database is unreachable");
        summary.failed += 1;
        continue;
      }
      const head = await readLiveHead(db, workspaceId);
      if (!head) continue; // an empty log has nothing to anchor
      const known = latest.ok ? (latest.records.get(workspaceId) ?? null) : null;

      // Compare the live chain with the newest anchor first: a mismatch is never anchored over.
      const ev = await evaluateAnchor(ctx, latest, head);
      const status = await recordEvaluation(ctx, ev);
      if (status.state === "mismatch") {
        summary.mismatched += 1;
        continue;
      }
      if (known && known.chain_seq === head.seq && known.head_hash === head.hash) {
        await anchorHead(ctx, known); // already anchored: clears a stale failure streak, writes nothing else
        summary.skipped += 1;
        continue;
      }

      // Verify only the rows since the last anchor (plus the link row); a first anchor checks the newest window.
      const limit = known ? Math.min(Math.max(head.seq - known.chain_seq + 1, 1), VERIFY_MAX_LIMIT) : VERIFY_DEFAULT_LIMIT;
      const verified = await verifyWindow(db, workspaceId, limit);
      if (!verified.ok) {
        await recordBad(ctx, "mismatch", "the audit chain does not verify; nothing was anchored", {
          first_bad_id: verified.firstBadId,
          window_rows: limit,
        });
        summary.mismatched += 1;
        continue;
      }

      const out = await anchorHead(ctx, known);
      if (out.outcome === "anchored") summary.anchored += 1;
      else if (out.outcome === "skipped") summary.skipped += 1;
      else if (out.outcome === "mismatch") summary.mismatched += 1;
      else if (out.outcome === "failed") {
        summary.failed += 1;
        sinkDown = true; // no further attempts this tick
        downReason = out.status.reason ?? "";
      }
    } catch (err) {
      console.error("[anchor] workspace anchor step failed:", safeAnchorError(err));
      summary.failed += 1;
    }
  }
  return summary;
}
