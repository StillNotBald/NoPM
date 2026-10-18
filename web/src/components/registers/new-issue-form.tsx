"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { IssueForm } from "@/components/forms/issue-form";

type Project = { id: string; name: string };

/**
 * Header action: opens the "New Issue" form in the right push-panel.
 *
 * The form carries its own required Project picker; `defaultProjectId`
 * preselects the register's active project filter (ignored if it isn't one of
 * `projects`).
 */
export function NewIssueButton({
  projects,
  defaultProjectId,
}: {
  projects: Project[];
  defaultProjectId?: string;
}) {
  const inspector = useInspector();

  function openNew() {
    inspector.open(
      <IssueForm projectId={defaultProjectId ?? ""} projects={projects} />,
      "New Issue",
    );
  }

  return (
    <Button
      variant="primary"
      className="h-11 sm:h-10"
      disabled={projects.length === 0}
      onClick={openNew}
    >
      <Plus size={16} className="mr-1.5" />
      New Issue
    </Button>
  );
}
