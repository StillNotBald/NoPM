// Wave-5 Pre-1: the security and integrations slice of the M1 atomicity exception list (owner: builder W5-B).
// MFA, connectors, GitHub connector, assistant token, invites, identities. W5-B (migration 0109, R-163 and R-164)
// converted all 12 entries, so the slice is now empty; the file stays so the merge in atomicity.test.ts keeps working.
// Each line would be one handler or library file that still writes first and audits second.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";

// NOT absolute: one place is still deliberately not atomic, and the scanner cannot see it (the write is an RPC):
//   - lib/assistant/token.ts revokeEphemeralToken: when the AUDITED revoke fails, it falls back to a plain revoke with no audit
//     row (logged) so a leaked ephemeral token can always be killed. Reason: security over audit for a 10-minute token.
// (The identity refusal is atomic now: burn and integration.identity.link.blocked are one transaction, no swallow.)
export const EXCEPTIONS: Record<string, AtomicityException> = {};
