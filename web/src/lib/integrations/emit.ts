import type { ApprovalDecidedEvent, ApprovalEvent } from "@/lib/integrations/types";

/**
 * Integration Hub entry points called by the governed request/decision code
 * paths (src/lib/governance/decide.ts and the request-creation routes).
 *
 * Contract (PLAN.md): synchronous, NEVER throw into the caller's mutation,
 * and do all I/O asynchronously (Next.js `after()` when inside a request).
 * They run AFTER the governed change and its audit row are committed, so an
 * integration outage can never block or roll back a governed write — chat
 * delivery is best-effort, the audit log is the record.
 *
 * STUB — implemented by W3a (hub core). Keep these signatures.
 */
export function emitApprovalRequested(ev: ApprovalEvent): void {
  void ev;
}

export function emitApprovalDecided(ev: ApprovalDecidedEvent): void {
  void ev;
}
