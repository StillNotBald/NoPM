import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { ok, validationError } from "@/lib/api/response";
import { ScopeError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { anchorHead, evaluateAnchor, recordEvaluation, windowCoversAnchor } from "@/lib/audit/anchor/anchor";
import { safeAnchorError } from "@/lib/audit/anchor/sink";
import { getAnchorSink } from "@/lib/audit/anchor/get-sink";
import type { AnchorStatus } from "@/lib/audit/anchor/compare";

export const runtime = "nodejs";

/** One verification per workspace per 5 minutes: the walk reads up to `limit` audit rows. */
export const VERIFY_WINDOW_SECONDS = 300;
export const VERIFY_DEFAULT_LIMIT = 50_000;
export const VERIFY_MAX_LIMIT = 200_000;

/**
 * GET /api/audit/verify — recompute this workspace's audit hash chain (migration 0104, R-154).
 *
 * Admin or manager SESSION only, like the access-review exports: a token of any scope gets 403.
 * Optional `?from=<ISO timestamp>` checks only rows created at or after that instant; optional
 * `?limit=<n>` (default 50000, at most 200000) checks only the newest n rows. A partial check is
 * anchored on the stored link of its oldest row, so `first_seq` says where the window began.
 *
 * Throttled: one run per workspace per 5 minutes. A second call inside the window answers 429 with
 * Retry-After and the last recorded result in `last_result`, so a manager cannot hammer the database.
 *
 * Verifying is a read, but it is audited like every export: one fail-closed `audit.verified` row
 * records the result. `head_hash` is the newest row_hash BEFORE that audit row; the weekly report and
 * the audit pack print it so it is kept outside the database (see the 0104 header).
 *
 * External anchor (R-168/R-169, migration 0112). Order: verify, compare the live chain with the newest
 * anchor in the anchor database, write `audit.verified` (its `after.anchor` records the state before),
 * and only when the chain verified ok and the state is not `mismatch`, anchor the head that now includes
 * the verify row. `anchor.state` is not_anchored | anchored | behind | mismatch | unreachable; "anchored"
 * is reported only when a comparison or a successful read-back happened. A `mismatch` makes `ok` false
 * (`chain_ok` keeps the plain chain result); `all_clear` is true only when `ok` and the anchor is
 * neither mismatch nor unreachable. A failed anchor write never fails the request.
 */
export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user" || !["admin", "manager"].includes(actor.role ?? "")) {
    throw new ScopeError("Verifying the audit chain requires an admin or manager session");
  }

  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  if (from !== null && Number.isNaN(Date.parse(from))) {
    return validationError("Validation failed", [{ field: "from", message: "from must be a parsable ISO 8601 timestamp" }]);
  }
  const rawLimit = params.get("limit");
  let limit = VERIFY_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1 || n > VERIFY_MAX_LIMIT) {
      return validationError("Validation failed", [
        { field: "limit", message: `limit must be a whole number from 1 to ${VERIFY_MAX_LIMIT}` },
      ]);
    }
    limit = n;
  }

  const db = createAdminClient();

  // Throttle (atomic fixed-window counter shared with the API rate limiter). Fail-open on an
  // infrastructure error, like the baseline limiter: this is abuse protection, not an auth control.
  const { data: gate, error: gateError } = await db.rpc("nopm_rate_check", {
    p_key: `audit-verify:${actor.workspaceId}`,
    p_max: 1,
    p_window_seconds: VERIFY_WINDOW_SECONDS,
  });
  if (gateError) {
    console.error("[nopm] audit verify throttle unavailable, failing open", gateError.message);
  } else if ((gate as { allowed?: boolean } | null)?.allowed === false) {
    const retry = Math.max(1, Number((gate as { retry_after_seconds?: number }).retry_after_seconds ?? VERIFY_WINDOW_SECONDS));
    const { data: last } = await db
      .from("audit_log")
      .select("after, created_at")
      .eq("workspace_id", actor.workspaceId)
      .eq("action", "audit.verified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return NextResponse.json(
      {
        error: "The audit chain was verified a moment ago. Try again later.",
        code: "verify_throttled",
        retry_after_seconds: retry,
        last_result: last ? { ...(last.after as object), recorded_at: last.created_at } : null,
      },
      { status: 429, headers: { "retry-after": String(retry) } },
    );
  }

  const { data, error } = await db.rpc("nopm_audit_verify_chain", {
    p_workspace_id: actor.workspaceId,
    p_from: from,
    p_limit: limit,
  });
  if (error) throw error;
  const res = (Array.isArray(data) ? data[0] : data) as
    | { ok: boolean; checked: number | string; first_bad_id: string | null; first_bad_at: string | null; first_seq: number | string | null }
    | undefined;
  if (!res) throw new Error("Audit chain verification returned no result");

  const { data: head, error: headError } = await db
    .from("audit_log")
    .select("row_hash")
    .eq("workspace_id", actor.workspaceId)
    .order("chain_seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (headError) throw headError;

  const chainOk = res.ok === true;
  const sink = getAnchorSink();
  const anchorCtx = { db, sink, workspaceId: actor.workspaceId, actor };
  // Compare the live chain with the newest anchor (state BEFORE this verify row exists).
  const before = await evaluateAnchor(anchorCtx);
  const beforeStatus = await recordEvaluation(anchorCtx, before);
  const mismatchBefore = beforeStatus.state === "mismatch";

  const result = {
    ok: chainOk && !mismatchBefore,
    chain_ok: chainOk,
    checked: Number(res.checked),
    first_bad_id: res.first_bad_id ?? null,
    first_bad_at: res.first_bad_at ?? null,
    first_seq: res.first_seq == null ? null : Number(res.first_seq),
    from: from ?? null,
    limit,
    head_hash: (head?.row_hash as string | undefined) ?? null,
    verified_at: new Date().toISOString(),
  };

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "audit.verified",
    targetType: "audit_log",
    targetId: null,
    before: null,
    after: {
      ...result,
      // The anchor state at this verify, so the chained trail itself records it (PR-16).
      anchor: {
        state: beforeStatus.state,
        chain_seq: beforeStatus.chain_seq,
        anchored_at: beforeStatus.anchored_at,
        rows_behind: beforeStatus.rows_behind,
      },
    },
  });

  // Anchor the head that includes the verify row, only when the chain verified and nothing diverged.
  let anchor: AnchorStatus = beforeStatus;
  // ...and only when the window that was checked reaches back to the previous anchor or to row 1 (W2-04):
  // `?limit=1` must not put "anchored" on a chain nobody checked end to end.
  const firstSeq = res.first_seq == null ? null : Number(res.first_seq);
  const covers = windowCoversAnchor(firstSeq, before.latest?.chain_seq ?? null);
  if (sink.kind !== "none" && chainOk && covers && !mismatchBefore && beforeStatus.state !== "unreachable") {
    try {
      const out = await anchorHead(anchorCtx, before.latest);
      if (out.outcome !== "disabled" && out.outcome !== "empty") anchor = out.status;
    } catch (err) {
      // Fail-open: the verify itself succeeded; an anchor that could not run is reported as not done.
      console.error("[nopm] audit anchor could not run:", safeAnchorError(err));
    }
  }

  const finalOk = result.ok && anchor.state !== "mismatch";
  return ok({
    ...result,
    ok: finalOk,
    all_clear: finalOk && anchor.state !== "unreachable",
    anchor: {
      state: anchor.state,
      chain_seq: anchor.chain_seq,
      anchored_at: anchor.anchored_at,
      row_count: anchor.row_count,
      rows_behind: anchor.rows_behind,
      since: anchor.since,
      reset_at: anchor.reset_at,
    },
  });
});
