"use client";

import { useEffect } from "react";
import { useInspector } from "@/components/layout/app-shell";
import { useFocusParam } from "@/lib/nav/use-focus-param";
import { IssueDetail, type IssueDetailProps } from "@/components/registers/issue-detail";

type IssueRow = IssueDetailProps["issue"];

/**
 * Client component mounted inside <Suspense> on the issues page.
 * Reads ?issue=<id>, finds the matching row, and auto-opens the inspector.
 * Renders null — purely a behaviour hook.
 */
export function IssueFocusOpener({
  issues,
  projectMap,
}: {
  issues: IssueRow[];
  projectMap: Record<string, string>;
}) {
  const { focusId, clear } = useFocusParam("issue");
  const inspector = useInspector();

  useEffect(() => {
    if (!focusId) return;
    const issue = issues.find((i) => i.id === focusId);
    if (!issue) return;

    const projectName = issue.project_id ? (projectMap[issue.project_id] ?? undefined) : undefined;

    inspector.open(
      <IssueDetail issue={issue} projectName={projectName} />,
      issue.reference_id ? `Issue ${issue.reference_id}` : "Issue Detail",
    );
    clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return null;
}
