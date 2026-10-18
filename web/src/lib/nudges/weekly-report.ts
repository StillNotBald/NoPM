import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit, systemActor } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { notifyEach, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { gatherDigestData } from "@/lib/integrations/digest-data";
import { getWorkspaceTimeZone, shiftToZone, todayInZone } from "@/lib/integrations/time-zone";
import { sanitizeError } from "@/lib/integrations/secrets";
import { getNudgeSettings } from "@/lib/nudges/settings";
import { findStaleItems } from "@/lib/nudges/stale";
import type { WeeklySnapshot } from "@/lib/reports/weekly-html";

/**
 * Weekly status report (R-142, audit item A3).
 *
 * On the configured weekday (workspace time zone), or the first daily run after it
 * in the same ISO week if that day was missed, the cron step builds
 * the same data the Lark weekly card uses, stores it as a `weekly_reports`
 * snapshot, and drops an in-app notification on every admin and manager that
 * links to the rendered HTML view (`GET /api/reports/weekly?week=`). The
 * notification doubles as the email demo-preview (Email previews renders every
 * notification as the email it WOULD be); nothing is ever sent.
 *
 * The button on the settings page calls the same function with
 * `trigger: "manual"`: it refreshes the current week's snapshot and notifies
 * the same people, but it never takes the scheduled run's once-a-day slot, so
 * pressing it does not stop Monday's report going out.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_LIST_CAP = 25;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Monday (YYYY-MM-DD) of the ISO week holding the given calendar day. */
export function weekStartOfDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return new Date(d.getTime() - (iso - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of `now` in the zone. */
export function isoWeekdayInZone(now: Date, timeZone: string): number {
  const dow = shiftToZone(now, timeZone).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/**
 * `?week=` accepts a calendar day (any day of the week) or an ISO week such as
 * 2026-W42. Returns that week's Monday, or null when it is neither.
 */
export function parseWeekParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) {
    const t = Date.parse(`${v}T00:00:00Z`);
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
    return weekStartOfDay(v);
  }
  const wk = /^(\d{4})-W(\d{2})$/i.exec(v);
  if (wk) {
    const year = Number(wk[1]);
    const week = Number(wk[2]);
    if (week < 1 || week > 53) return null;
    // ISO week 1 is the week holding 4 January.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week1Monday = weekStartOfDay(jan4.toISOString().slice(0, 10));
    const monday = new Date(Date.parse(`${week1Monday}T00:00:00Z`) + (week - 1) * 7 * DAY_MS);
    // Week 53 only exists in some years: the Monday must still fall in the named ISO year's Thursday.
    const thursday = new Date(monday.getTime() + 3 * DAY_MS);
    if (thursday.getUTCFullYear() !== year) return null;
    return monday.toISOString().slice(0, 10);
  }
  return null;
}

/** Build the snapshot a report renders from (read-only). */
export async function buildWeeklySnapshot(workspaceId: string, now: Date, weekStart: string): Promise<WeeklySnapshot> {
  const timeZone = await getWorkspaceTimeZone(workspaceId);
  const settings = await getNudgeSettings(workspaceId);
  const digest = await gatherDigestData(workspaceId, { now, timeZone });
  let stale: WeeklySnapshot["stale"] = [];
  try {
    const items = await findStaleItems(createAdminClient(), workspaceId, settings.stale_days, now);
    stale = items.slice(0, STALE_LIST_CAP).map((i) => ({
      kind: i.kind,
      title: i.title,
      projectCode: i.projectCode,
      projectName: i.projectName,
      daysStale: i.daysStale,
    }));
  } catch (err) {
    console.error("[nudges] weekly report stale list failed:", sanitizeError(err));
  }
  return { weekStart, digest, staleDays: settings.stale_days, stale };
}

/** The stored snapshot for a week, or null. */
export async function loadWeeklySnapshot(workspaceId: string, weekStart: string): Promise<WeeklySnapshot | null> {
  const { data, error } = await createAdminClient()
    .from("weekly_reports")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error) throw error;
  const snap = (data as { data?: WeeklySnapshot } | null)?.data;
  return snap ?? null;
}

export type WeeklyRunResult =
  | { status: "disabled" | "not_today" | "already_sent" | "no_recipients" | "failed" }
  | { status: "generated"; weekStart: string; recipients: number };

type RunOpts = { now?: Date; trigger: "scheduled" | "manual"; actor?: Actor };

async function storeSnapshot(db: Db, workspaceId: string, snap: WeeklySnapshot, generatedBy: string, now: Date) {
  const existing = await db.from("weekly_reports").select("id").eq("workspace_id", workspaceId).eq("week_start", snap.weekStart).maybeSingle();
  if (existing.error) throw existing.error;
  const row = { data: snap, generated_at: now.toISOString(), generated_by: generatedBy };
  const res = existing.data
    ? await db.from("weekly_reports").update(row).eq("id", existing.data.id).eq("workspace_id", workspaceId)
    : await db.from("weekly_reports").insert({ workspace_id: workspaceId, week_start: snap.weekStart, ...row });
  if (res.error) throw res.error;
}

/**
 * Generate, store, audit and announce one workspace's weekly report.
 * `scheduled` honours the enabled flag, the weekday and the once-a-day slot;
 * `manual` ignores all three. Never throws: a failure is logged and returned.
 */
export async function generateWeeklyReport(workspaceId: string, opts: RunOpts): Promise<WeeklyRunResult> {
  const now = opts.now ?? new Date();
  const db: Db = createAdminClient();
  try {
    const settings = await getNudgeSettings(workspaceId);
    const timeZone = await getWorkspaceTimeZone(workspaceId);
    const today = todayInZone(timeZone, now);
    const weekStart = weekStartOfDay(today);

    if (opts.trigger === "scheduled") {
      if (!settings.weekly_report_enabled) return { status: "disabled" };
      // On the chosen day, or any later day of the same ISO week if that tick was missed (catch-up).
      if (isoWeekdayInZone(now, timeZone) < settings.weekly_report_day) return { status: "not_today" };
    }

    const recipients = await resolveWorkspaceApprovers(workspaceId);
    if (recipients.length === 0) return { status: "no_recipients" };

    // Scheduled runs take a ledger row per recipient; one earlier this ISO week means this week is done.
    let toNotify = recipients;
    if (opts.trigger === "scheduled") {
      const { data, error } = await db
        .from("nudge_log")
        .select("recipient_id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "weekly_report")
        .eq("target_id", workspaceId)
        .gte("sent_on", weekStart); // idempotent by week: a scheduled send earlier this week counts
      if (error) throw error;
      const done = new Set(((data ?? []) as { recipient_id: string }[]).map((r) => r.recipient_id));
      toNotify = recipients.filter((id) => !done.has(id));
      if (toNotify.length === 0) return { status: "already_sent" };
      const claim = await db.from("nudge_log").insert(
        toNotify.map((id) => ({
          workspace_id: workspaceId,
          target_type: "workspace",
          target_id: workspaceId,
          kind: "weekly_report",
          recipient_id: id,
          sent_on: today,
        })),
      );
      if (claim.error) {
        // A racing tick took the slot (unique violation) or the ledger is unavailable: send nothing.
        console.error("[nudges] weekly report claim failed:", sanitizeError(claim.error));
        return { status: "already_sent" };
      }
    }

    const snap = await buildWeeklySnapshot(workspaceId, now, weekStart);
    const actor = opts.actor ?? systemActor(workspaceId, "weekly-report", { channel: "api" });
    try {
      await storeSnapshot(db, workspaceId, snap, actor.label, now);
      await writeAudit({
        workspaceId,
        actor,
        action: "report.weekly.generated",
        targetType: "workspace",
        targetId: workspaceId,
        after: { week_start: weekStart, trigger: opts.trigger, recipients: toNotify.length },
      });
    } catch (err) {
      // Fail-closed: no audit row, nobody is told. Free the day's slot so the next tick retries.
      console.error("[nudges] weekly report not stored or audited:", sanitizeError(err));
      if (opts.trigger === "scheduled") {
        await db.from("nudge_log").delete().eq("workspace_id", workspaceId).eq("kind", "weekly_report").eq("sent_on", today);
      }
      return { status: "failed" };
    }

    const d = snap.digest;
    const stale = d.staleItems ?? 0;
    const body =
      `${d.projects.length} project${d.projects.length === 1 ? "" : "s"}, ` +
      `${d.openHighRisks} open high risk${d.openHighRisks === 1 ? "" : "s"}, ` +
      `${d.pendingApprovals} pending approval${d.pendingApprovals === 1 ? "" : "s"}, ` +
      `${stale} stale item${stale === 1 ? "" : "s"}.`;
    await notifyEach(
      workspaceId,
      toNotify.map((recipientId) => ({
        recipientId,
        type: "report.weekly" as const,
        title: `Weekly status report: week of ${weekStart}`,
        body,
        payload: { href: `/api/reports/weekly?week=${weekStart}`, week_start: weekStart },
      })),
    );
    return { status: "generated", weekStart, recipients: toNotify.length };
  } catch (err) {
    console.error("[nudges] weekly report failed:", sanitizeError(err));
    return { status: "failed" };
  }
}
