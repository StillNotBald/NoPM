// Wave-5 Pre-1: the unattended jobs slice of the M1 atomicity exception list (owner: builder W5-C).
// Clash detection, overspend marker, nightly snapshots, weekly report: all four are atomic since R-165
// (migration 0110), so this slice is empty. Add a line here only for a new, honestly non-atomic writer.
// The three slices never share a file, so parallel builders never collide.
import type { AtomicityException } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {};
