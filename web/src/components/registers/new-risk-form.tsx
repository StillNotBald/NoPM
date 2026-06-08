"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { RiskForm } from "@/components/forms/risk-form";

type Project = { id: string; name: string };

/** Header action: opens the "New Risk" form in the right push-panel. */
export function NewRiskButton({ projects }: { projects: Project[] }) {
  const inspector = useInspector();

  function openNew() {
    // Default to first project; user can switch inside the form if the full
    // RiskForm ever gets a project-picker.  For now we open per-project.
    const projectId = projects[0]?.id ?? "";
    inspector.open(
      <RiskForm projectId={projectId} />,
      "New Risk",
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
      New Risk
    </Button>
  );
}
