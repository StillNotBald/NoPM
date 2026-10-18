// Wave-5 Pre-1: the governance slice of the M1 atomicity exception list (owner: builder W5-A).
// Deletion flow, change requests, rebaselines. Empty since wave 5 W5-A (R-161, R-162): all eight entries are
// atomic now (dedicated database functions of migration 0108 write the change and its audit row together).
import type { AtomicityException } from "./atomicity-exceptions";

export const EXCEPTIONS: Record<string, AtomicityException> = {};
