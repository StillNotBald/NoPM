"use client";

import { useEffect } from "react";
import { useInspector } from "@/components/layout/app-shell";
import { useFocusParam } from "@/lib/nav/use-focus-param";
import { RiskDetail, type RiskDetailProps } from "@/components/registers/risk-detail";

type RiskRow = RiskDetailProps["risk"] & { owner_id?: string | null };

/**
 * Client component mounted inside <Suspense> on the risks page.
 * Reads ?risk=<id>, finds the matching row, and auto-opens the inspector.
 * Renders null — purely a behaviour hook.
 */
export function RiskFocusOpener({
  risks,
  projectMap,
  ownerMap,
}: {
  risks: RiskRow[];
  projectMap: Record<string, string>;
  ownerMap: Record<string, string>;
}) {
  const { focusId, clear } = useFocusParam("risk");
  const inspector = useInspector();

  useEffect(() => {
    if (!focusId) return;
    const risk = risks.find((r) => r.id === focusId);
    if (!risk) return;

    const projectName = risk.project_id ? (projectMap[risk.project_id] ?? undefined) : undefined;
    const ownerId = (risk as RiskRow).owner_id;
    const ownerName = ownerId ? (ownerMap[ownerId] ?? ownerId.slice(0, 8) + "…") : undefined;

    inspector.open(
      <RiskDetail risk={risk} projectName={projectName} ownerName={ownerName} />,
      risk.reference_id ? `Risk ${risk.reference_id}` : "Risk Detail",
    );
    clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return null;
}
