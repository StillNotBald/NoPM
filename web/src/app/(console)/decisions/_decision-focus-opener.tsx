"use client";

import { useEffect } from "react";
import { useFocusParam } from "@/lib/nav/use-focus-param";
import { useInspector } from "@/components/layout/app-shell";
import { DecisionDetail } from "@/components/decisions/decision-detail";
import type { Decision } from "@/components/decisions/decision-form";

interface Props {
  decisions: Decision[];
  projectMap: Record<string, string>;
  refMap: Record<string, string>;
  projects: Array<{ id: string; name: string }>;
}

/**
 * Reads ?dec=<id> and auto-opens the matching decision in the inspector.
 * Renders null — purely a side-effect component.
 * Must be wrapped in <Suspense> (Next.js requirement for useFocusParam).
 */
export function DecisionFocusOpener({ decisions, projectMap, refMap, projects }: Props) {
  const { focusId, clear } = useFocusParam("dec");
  const inspector = useInspector();

  useEffect(() => {
    if (!focusId) return;
    const decision = decisions.find((d) => d.id === focusId);
    if (!decision) return;

    const projectName = decision.project_id
      ? (projectMap[decision.project_id] ?? undefined)
      : undefined;
    const supersededByRef = decision.supersedes
      ? (refMap[decision.supersedes] ?? null)
      : null;

    inspector.open(
      <DecisionDetail
        decision={decision}
        projectName={projectName}
        supersededByRef={supersededByRef}
        projects={projects}
      />,
      decision.reference_id ? `Decision ${decision.reference_id}` : "Decision",
    );
    clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return null;
}
