// Wave-5 Pre-1: the unattended jobs slice of the M1 atomicity exception list (owner: builder W5-C).
// Clash detection, overspend marker, nightly snapshots, weekly report (4 entries).
// Each line is one handler or library file that still writes first and audits second.
// Delete a line here the moment that entry becomes atomic; atomicity.test.ts fails until you do.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";
import { ex } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {
  "lib/clash/detect.ts": ex("lead (follow-up)", "system auto-create and auto-resolve of clashes, then audit; clashes is allowlisted, convert with a system actor"),
  "lib/insight/overspend.ts": ex("lead (follow-up)", "sets the budget overspend level marker, then audits the crossing; project_budget is allowlisted"),
  "lib/insight/snapshots.ts": ex("lead (follow-up)", "nightly project_snapshots upsert, then one audit row for the whole run (system job, not a user change)"),
  "lib/nudges/weekly-report.ts": ex("lead (follow-up)", "stores the weekly report and its nudge claim, then audits the send; weekly_reports and nudge_log are not allowlisted"),
};
