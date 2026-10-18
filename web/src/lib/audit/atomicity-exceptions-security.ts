// Wave-5 Pre-1: the security and integrations slice of the M1 atomicity exception list (owner: builder W5-B).
// MFA, connectors, GitHub connector, assistant token, invites, identities. W5-B (migration 0109, R-163 and R-164)
// converted all 12 entries, so the slice is now empty; the file stays so the merge in atomicity.test.ts keeps working.
// Each line would be one handler or library file that still writes first and audits second.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {};
