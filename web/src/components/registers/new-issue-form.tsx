"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { IssueForm } from "@/components/forms/issue-form";

type Project = { id: string; name: string };

/** Header action: opens the "New Issue" form in the right push-panel. */
export function NewIssueButton({ projects }: { projects: Project[] }) {
  const inspector = useInspector();

  function openNew() {
    const projectId = projects[0]?.id ?? "";
    inspector.open(
      <IssueForm projectId={projectId} />,
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
