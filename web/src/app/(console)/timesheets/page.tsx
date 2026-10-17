import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, SelectInput } from "@/components/forms/project-form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { WeekGrid, type WeekGridRow } from "@/components/timesheets/week-grid";
import { ReportFilters } from "@/components/timesheets/report-filters";
import { LogTimeForm } from "@/components/timesheets/log-time-form";
import { TimesheetSubmitPanel } from "@/components/timesheets/submit-panel";
import { lockForWeek, type LockSubmission, type WeekLock } from "@/components/timesheets/week-lock";

export const metadata = { title: "Timesheets" };

type SearchParams = { [key: string]: string | string[] | undefined };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// ── Week math (Monday-first ISO weeks) ──────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Snap any date to the Monday of its week; an invalid/missing input falls back to today's week. */
function toMonday(dateStr: string | undefined): string {
  const source = dateStr && !Number.isNaN(new Date(`${dateStr}T00:00:00Z`).getTime()) ? dateStr : todayIso();
  const d = new Date(`${source}T00:00:00Z`);
  const day = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i));
}

interface MemberOption {
  id: string;
  name: string;
  capacity_hours_per_week: number | null;
}

interface WeekEntryRow {
  id: string;
  task_id: string | null;
  project_id: string | null;
  entry_date: string;
  hours: number | string | null;
}

/**
 * Timesheets console (L-28/L-30) — weekly grid + governed time report for
 * a single selected member, plus the first time-logging UI in the product.
 * Server component (auth redirect + RLS-scoped reads), matching
 * (console)/sprints/page.tsx: the week/member selector is a plain GET form
 * (no client JS needed to navigate — sets ?member=&week= and re-renders
 * server-side, same idiom as the sprint list's `?sprint=` links). The
 * report section below is the one client island (components/timesheets/
 * report-filters.tsx) — it needs its own live filter state.
 */
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await db
    .from("profiles")
    .select("role, workspace_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) redirect("/login");
  const canWrite = profile.role !== "viewer";

  // Caller's own linked resource_member(s) — a login can have >1 (recon-time
  // §1: my-work uses a singular lookup + nil-uuid sentinel; my-tasks uses a
  // plural array). Here we just need the first as the default selection.
  const { data: myMembers } = await db
    .from("resource_members")
    .select("id")
    .eq("profile_id", user.id)
    .order("name");

  const { data: allMembersRaw, error: membersError } = await db
    .from("resource_members")
    .select("id, name, capacity_hours_per_week")
    .order("name");

  if (membersError) {
    return <QueryError what="resource members" message={membersError.message} />;
  }

  const allMembers = (allMembersRaw ?? []) as MemberOption[];

  const sp = await searchParams;
  const requestedMemberId = firstParam(sp.member);
  const selectedMemberId =
    (requestedMemberId && allMembers.some((m) => m.id === requestedMemberId) ? requestedMemberId : undefined) ??
    myMembers?.[0]?.id ??
    allMembers[0]?.id ??
    null;
  const selectedMember = allMembers.find((m) => m.id === selectedMemberId) ?? null;

  const weekStart = toMonday(firstParam(sp.week));
  const weekEnd = addDaysIso(weekStart, 6);
  const dates = weekDates(weekStart);
  const prevWeek = addDaysIso(weekStart, -7);
  const nextWeek = addDaysIso(weekStart, 7);

  // L-31: latest timesheet_submissions row for this member+week (if any) —
  // read via the RLS-scoped session client (house read policy, no write
  // policy — writes only happen through the audited API routes).
  let submissionStatus: "submitted" | "approved" | "rejected" | null = null;
  let submissionReopened = false;
  let submissionId: string | null = null;
  // The week is FROZEN (the API refuses time-entry writes, 422 period_locked /
  // timesheet_locked) while a covering submission is approved, or submitted and
  // not reopened. Same rule as lib/governance/period-lock.ts, read here so the
  // grid and the Log time form can say so before anyone tries to write.
  let weekLock: WeekLock = null;
  if (selectedMemberId) {
    const { data: latestSubmission } = await db
      .from("timesheet_submissions")
      .select("id, status, reopened_at")
      .eq("member_id", selectedMemberId)
      .eq("period_start", weekStart)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    submissionStatus = (latestSubmission?.status as typeof submissionStatus) ?? null;
    submissionReopened = !!latestSubmission?.reopened_at;
    submissionId = (latestSubmission?.id as string | undefined) ?? null;

    const { data: openSubmissions } = await db
      .from("timesheet_submissions")
      .select("period_start, period_end, status, reopened_at")
      .eq("member_id", selectedMemberId)
      .in("status", ["submitted", "approved"]);
    weekLock = lockForWeek(dates, (openSubmissions ?? []) as LockSubmission[]);
  }

  let gridRows: WeekGridRow[] = [];
  if (selectedMemberId) {
    const { data: weekEntries } = await db
      .from("time_entries")
      .select("id, task_id, project_id, entry_date, hours")
      .eq("member_id", selectedMemberId)
      .gte("entry_date", weekStart)
      .lte("entry_date", weekEnd);

    const rows = (weekEntries ?? []) as WeekEntryRow[];
    const taskIds = [...new Set(rows.map((r) => r.task_id).filter((id): id is string => !!id))];
    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => !!id))];

    const [{ data: taskRows }, { data: projectRows }] = await Promise.all([
      taskIds.length > 0
        ? db.from("tasks").select("id, name").in("id", taskIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      projectIds.length > 0
        ? db.from("projects").select("id, name").in("id", projectIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    const taskNameById = new Map((taskRows ?? []).map((t) => [t.id, t.name]));
    const projectNameById = new Map((projectRows ?? []).map((p) => [p.id, p.name]));

    const rowMap = new Map<string, WeekGridRow>();
    for (const entry of rows) {
      const key = entry.task_id ? `task:${entry.task_id}` : `project:${entry.project_id ?? "none"}`;
      let row = rowMap.get(key);
      if (!row) {
        const projectLabel = entry.project_id
          ? (projectNameById.get(entry.project_id) ?? "Unknown project")
          : "No project";
        const label = entry.task_id
          ? `${taskNameById.get(entry.task_id) ?? "Unknown task"} — ${projectLabel}`
          : `${projectLabel} (no task)`;
        row = { key, label, hoursByDate: {}, loggedDates: new Set() };
        rowMap.set(key, row);
      }
      const hrs = typeof entry.hours === "string" ? Number(entry.hours) : (entry.hours ?? 0);
      row.hoursByDate[entry.entry_date] = (row.hoursByDate[entry.entry_date] ?? 0) + (Number.isFinite(hrs) ? hrs : 0);
      row.loggedDates.add(entry.entry_date);
    }
    gridRows = [...rowMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="space-y-6">
        <PageHeader title="Timesheets" />

        {allMembers.length === 0 ? (
          <Card>
            <EmptyState
              purpose="No team members yet. Add a resource member on the Resources page before logging time."
              docsHref="/resources"
              docsLabel="Go to Resources"
              canWrite={canWrite}
            />
          </Card>
        ) : (
          <>
            {canWrite && (
              <Card>
                <CardHeader>
                  <CardTitle>Log time</CardTitle>
                </CardHeader>
                <CardBody>
                  <LogTimeForm
                    defaultMemberId={selectedMemberId ?? undefined}
                    ownMemberIds={profile.role === "member" ? (myMembers ?? []).map((m) => m.id as string) : undefined}
                  />
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader>
                <div className="flex min-w-0 items-center gap-2">
                  <CardTitle>Week grid</CardTitle>
                  {selectedMember && <span className="text-xs text-ink-muted truncate">— {selectedMember.name}</span>}
                </div>
                {/* Prev/Next moved into the filter row below (R-94) — with
                    Submit still here, three items in this one non-wrapping
                    row overflowed the header on phones (F-mobile: the
                    "Next" link clipped past the viewport edge). The filter
                    row already wraps (`flex flex-wrap`), so Prev/Next live
                    there instead where they can drop to their own line. */}
                <TimesheetSubmitPanel
                  memberId={selectedMemberId}
                  periodStart={weekStart}
                  canWrite={canWrite}
                  initialStatus={submissionStatus}
                  reopened={submissionReopened}
                  submissionId={submissionId}
                  canReopen={profile.role === "admin" || profile.role === "manager"}
                />
              </CardHeader>
              <CardBody pad="none" className="border-b border-border-subtle p-4">
                <form action="/timesheets" method="get" className="flex flex-wrap items-end gap-3">
                  <Field label="Member">
                    <SelectInput name="member" defaultValue={selectedMemberId ?? ""} className="sm:w-56">
                      {allMembers.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </SelectInput>
                  </Field>
                  <Field label="Week of (Monday)">
                    <Input type="date" name="week" defaultValue={weekStart} className="sm:w-44" />
                  </Field>
                  <Button type="submit" variant="secondary" size="sm" className="h-11 sm:h-9">
                    View
                  </Button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Link
                      href={`/timesheets?member=${selectedMemberId ?? ""}&week=${prevWeek}`}
                      className="inline-flex h-11 items-center rounded-md border border-border-subtle px-2.5 text-xs text-ink-secondary hover:bg-sunken sm:h-9"
                    >
                      ← Prev
                    </Link>
                    <Link
                      href={`/timesheets?member=${selectedMemberId ?? ""}&week=${nextWeek}`}
                      className="inline-flex h-11 items-center rounded-md border border-border-subtle px-2.5 text-xs text-ink-secondary hover:bg-sunken sm:h-9"
                    >
                      Next →
                    </Link>
                  </div>
                </form>
              </CardBody>
              <CardBody pad="none">
                <WeekGrid
                  weekDates={dates}
                  rows={gridRows}
                  capacityHoursPerWeek={selectedMember?.capacity_hours_per_week ?? null}
                  lock={weekLock}
                  emptyMessage={
                    selectedMember
                      ? `No time logged for ${selectedMember.name} in the week of ${weekStart}.`
                      : "Select a member to see their week."
                  }
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Time report</CardTitle>
              </CardHeader>
              <CardBody>
                <ReportFilters />
              </CardBody>
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
