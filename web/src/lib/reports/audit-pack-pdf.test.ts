import { describe, it, expect } from "vitest";
import { renderAuditPackPdf } from "./pdf";
import type { AuditPackData } from "@/lib/export/audit-pack";

const base: AuditPackData = {
  workspaceName: "Acme Delivery",
  from: "2026-10-01",
  to: "2026-10-31",
  generatedAt: "2026-10-18T10:00:00.000Z",
  generatedBy: "Auditor Liaison",
  changeRequests: [],
  evidence: [],
  decisions: [],
  audit: [],
  truncated: false,
  unavailable: { evidence: false, decisionLinks: false },
  totals: { change_requests: 0, evidence: 0, decisions: 0, approvals_audit: 0 },
};

const header = (b: Buffer) => b.subarray(0, 5).toString("latin1");
/** jsPDF writes text uncompressed, so drawn strings are searchable in the bytes. */
const text = (b: Buffer) => b.toString("latin1");
const pageCount = (b: Buffer) => (text(b).match(/\/Type \/Page\b/g) ?? []).length;

describe("renderAuditPackPdf", () => {
  it("renders an empty pack as a PDF", () => {
    const out = renderAuditPackPdf(base);
    expect(header(out)).toBe("%PDF-");
    expect(out.length).toBeGreaterThan(1000);
  });

  it("renders a two-request pack with evidence and audit rows", () => {
    const out = renderAuditPackPdf({
      ...base,
      changeRequests: [
        {
          id: "cr1", ref: "CR-001", title: "Move go-live and a deliberately long title that must be clipped to fit its column",
          status: "approved", decided_at: "2026-10-03T09:00:00Z", decided_by_label: "Sam",
          implemented_at: "2026-10-05T00:00:00Z", evidence_pass: 1, evidence_fail: 1,
        },
        { id: "cr2", ref: "CR-002", title: "Drop module", status: "rejected", decided_at: null, evidence_pass: 0, evidence_fail: 0 },
      ],
      evidence: [
        { id: "d1", change_request_ref: "CR-001", title: "UAT sign-off", evidence_type: "uat", evidence_result: "pass", tested_by_label: "Pat", tested_at: "2026-10-05T08:00:00Z" },
        { id: "d2", change_request_ref: "CR-001", title: "Smoke run", evidence_type: "test", evidence_result: "fail", tested_by_label: "Pat", tested_at: null, created_at: "2026-10-06T00:00:00Z" },
      ],
      audit: [{ id: "a1", action: "change_request.decide", actor_label: "Sam", principal_label: "Lee", change_request_ref: "CR-001", created_at: "2026-10-03T09:00:00Z" }],
      totals: { change_requests: 2, evidence: 2, decisions: 0, approvals_audit: 1 },
    });
    expect(header(out)).toBe("%PDF-");
    const t = text(out);
    for (const needle of ["CR-001", "CR-002", "Sam", "2026-10-05", "1 / 1", "UAT sign-off", "Pat", "change_request.decide", "Acme Delivery", "Implemented"]) {
      expect(t).toContain(needle);
    }
  });

  it("counts implemented requests as approved on the cover", () => {
    const mk = (status: string, i: number) => ({ id: "c" + i, ref: "CR-" + i, title: "t", status, evidence_pass: 0, evidence_fail: 0 });
    const t = text(renderAuditPackPdf({ ...base, changeRequests: [mk("approved", 1), mk("implemented", 2), mk("rejected", 3)], totals: { ...base.totals, change_requests: 3 } }));
    // cards draw their numbers as separate strings: change requests 3, approved 2, implemented 1
    expect(t).toMatch(/\(3\) Tj[\s\S]*?\(2\) Tj[\s\S]*?\(1\) Tj/);
  });

  it("renders a decisions table and an older-schema notice", () => {
    const t = text(
      renderAuditPackPdf({
        ...base,
        decisions: [{ id: "d", reference_id: "DEC-7", title: "Adopt vendor B", change_request_ref: "CR-001", status: "accepted", decided_at: "2026-10-03T00:00:00Z", rationale: "Cheaper" }],
        unavailable: { evidence: true, decisionLinks: false },
      }),
    );
    for (const needle of ["DEC-7", "Adopt vendor B", "Cheaper", "schema older than 0093/0094"]) expect(t).toContain(needle);
  });

  it("paginates a long register without throwing", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: "c" + i, ref: "CR-" + i, title: "Change " + i, status: "approved", evidence_pass: 0, evidence_fail: 0 }));
    const long = renderAuditPackPdf({ ...base, changeRequests: many, totals: { ...base.totals, change_requests: 120 } });
    expect(header(long)).toBe("%PDF-");
    expect(pageCount(long)).toBeGreaterThan(pageCount(renderAuditPackPdf(base)));
    expect(text(long)).toContain("CR-119");
  });
});
