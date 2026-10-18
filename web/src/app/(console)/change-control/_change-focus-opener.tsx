"use client";

import { useEffect } from "react";
import { useFocusParam } from "@/lib/nav/use-focus-param";
import { useInspector } from "@/components/layout/app-shell";
import { ChangeDetail } from "@/components/change-control/change-detail";
import type { ChangeRequest } from "@/components/change-control/change-form";

interface Props {
  changeRequests: ChangeRequest[];
  projectMap: Record<string, string>;
  projects: Array<{ id: string; name: string }>;
}

/**
 * Reads ?cr=<id> and auto-opens the matching change request in the inspector.
 * Renders null — purely a side-effect component.
 * Must be wrapped in <Suspense> (Next.js requirement for useFocusParam).
 */
export function ChangeFocusOpener({ changeRequests, projectMap, projects }: Props) {
  const { focusId, clear } = useFocusParam("cr");
  const inspector = useInspector();

  useEffect(() => {
    if (!focusId) return;
    const cr = changeRequests.find((r) => r.id === focusId);
    if (!cr) return;

    const projectName = cr.project_id
      ? (projectMap[cr.project_id] ?? undefined)
      : undefined;

    inspector.open(
      <ChangeDetail cr={cr} projectName={projectName} projects={projects} />,
      cr.reference_id ? `CR ${cr.reference_id}` : "Change Request",
    );
    clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return null;
}
