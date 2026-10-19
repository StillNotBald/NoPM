// Wave-5 Pre-1: the governance slice of the M1 atomicity exception list (owner: builder W5-A).
// Deletion flow, change requests, rebaselines. Empty since wave 5 W5-A (R-161, R-162): all eight entries are
// atomic now (dedicated database functions of migration 0108 write the change and its audit row together).
import type { AtomicityException } from "./atomicity-exceptions";

// Honest scope of "empty": every business write of these flows is now one transaction with its audit row. Residual
// places that are deliberately NOT atomic live in other slices and are named here so the empty list is not read as
// absolute (each is a decided trade-off, not an oversight):
//   - lib/integrations/identity.ts: a refused identity replacement burns the link code and audits
//     integration.identity.link.blocked inside a swallowing block, so a failed audit loses the record of the refusal
//     (W5-B, migration 0109, nopm_link_identity).
//   - lib/assistant/token.ts: the assistant token revoke falls back to a plain revoke with no audit row when the
//     audited revoke fails, so a leaked ephemeral token can always be killed (W5-B).
// The deadline_set approval-ledger event of deletion requests, change requests and rebaselines was fail-soft before
// and is now inside the same transaction (migration 0108), so it is no longer a residual.
export const EXCEPTIONS: Record<string, AtomicityException> = {};
