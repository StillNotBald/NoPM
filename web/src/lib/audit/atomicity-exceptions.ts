// Wave-5 Pre-1: shared shape for the three atomicity exception slices.
export type AtomicityException = { reason: string; owner: string };
export const ex = (owner: string, reason: string): AtomicityException => ({ owner, reason });
