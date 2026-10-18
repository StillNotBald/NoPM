// Wave-5 Pre-1: the governance slice of the M1 atomicity exception list (owner: builder W5-A).
// Deletion flow, change requests, rebaselines (8 entries).
// Each line is one handler or library file that still writes first and audits second.
// Delete a line here the moment that entry becomes atomic; atomicity.test.ts fails until you do.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";
import { ex } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {
  "projects/[id]#DELETE": ex("deletion-flow wave", "inserts a deletion_requests row (maker step of the four-eyes flow, not an allowlisted table), then audits project.delete_requested"),
  "tasks/[id]#DELETE": ex("deletion-flow wave", "inserts a deletion_requests row (maker step of the four-eyes flow, not an allowlisted table), then audits task.delete_requested"),
  "projects/[id]/change-requests#POST": ex("approval-tier wave", "change-request raise: governance path with tier routing, needs its own function"),
  "projects/[id]/rebaselines#POST": ex("approval-tier wave", "rebaseline draft: governance path, needs its own function"),
  "change-requests/[id]#PATCH": ex("approval-tier wave", "edit of a raised change request: update then audit, change_requests is not an allowlisted table"),
  "change-requests/[id]#DELETE": ex("approval-tier wave", "withdraw of a raised change request: status update then audit, change_requests is not an allowlisted table"),
  "lib/governance/request-deletion.ts": ex("deletion-flow wave", "the five *.delete_requested writes (risk, issue, expense, document, milestone): deletion_requests insert, then audit"),
  "lib/governance/decide.ts": ex("deletion-flow wave", "withdraw and reopen of deletion requests: status update then audit; the approve path is already an RPC"),
};
