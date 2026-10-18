import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/integrations/secrets";
import { runStaleNudges } from "@/lib/nudges/stale";
import { generateWeeklyReport } from "@/lib/nudges/weekly-report";

/**
 * The daily nudge step of the scheduler tick (R-141 / R-142). It is a SYSTEM
 * job like the rest of the tick: it walks every workspace (keyset-paged, so a
 * PostgREST row cap never hides the tail) and runs that workspace's stale-item
 * pass and, on the configured weekday, its weekly report. Stops STARTING a
 * workspace at the deadline; whatever it did not reach is picked up tomorrow
 * (stale) or by the "Send weekly report now" button (weekly). One workspace's
 * failure never blocks the others.
 */

const PAGE = 200;

export type NudgeStepSummary = {
  workspaces: number;
  /** Stale items nudged (notifications written). */
  staleNudged: number;
  weeklyReports: number;
  failed: number;
  skippedForDeadline: number;
};

export const EMPTY_NUDGE_STEP: NudgeStepSummary = {
  workspaces: 0,
  staleNudged: 0,
  weeklyReports: 0,
  failed: 0,
  skippedForDeadline: 0,
};

export async function runNudgeStep(now: Date, deadline: number): Promise<NudgeStepSummary> {
  const summary: NudgeStepSummary = { ...EMPTY_NUDGE_STEP };
  const db = createAdminClient();
  let after: string | null = null;
  for (;;) {
    let q = db.from("workspaces").select("id").order("id", { ascending: true }).limit(PAGE);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) {
      console.error("[nudges] workspace listing failed:", sanitizeError(error));
      summary.failed += 1;
      return summary;
    }
    const page = (data ?? []) as { id: string }[];
    for (const ws of page) {
      summary.workspaces += 1;
      if (Date.now() >= deadline) {
        summary.skippedForDeadline += 1;
        continue;
      }
      try {
        const stale = await runStaleNudges(ws.id, now);
        if (stale.status === "sent") summary.staleNudged += stale.sent;
        else if (stale.status === "failed") summary.failed += 1;
        const weekly = await generateWeeklyReport(ws.id, { now, trigger: "scheduled" });
        if (weekly.status === "generated") summary.weeklyReports += 1;
        else if (weekly.status === "failed") summary.failed += 1;
      } catch (err) {
        console.error("[nudges] workspace nudge step failed:", sanitizeError(err));
        summary.failed += 1;
      }
    }
    if (page.length < PAGE) return summary;
    after = page[page.length - 1].id;
  }
}
