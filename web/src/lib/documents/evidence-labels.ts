/** Evidence vocabulary shared by the API schema, the document form and the evidence panel. Pure: safe in client code. */

export const EVIDENCE_TYPES = ["test_result", "uat_signoff", "deploy_record", "screenshot", "other"] as const;
export const EVIDENCE_RESULTS = ["pass", "fail", "partial", "n/a"] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  test_result: "Test result",
  uat_signoff: "UAT sign-off",
  deploy_record: "Deploy record",
  screenshot: "Screenshot",
  other: "Other",
};

export const EVIDENCE_RESULT_LABELS: Record<EvidenceResult, string> = {
  pass: "Pass",
  fail: "Fail",
  partial: "Partial",
  "n/a": "Not applicable",
};

export function evidenceResultTone(r: string | null | undefined): "success" | "danger" | "warning" | "neutral" {
  if (r === "pass") return "success";
  if (r === "fail") return "danger";
  if (r === "partial") return "warning";
  return "neutral";
}
