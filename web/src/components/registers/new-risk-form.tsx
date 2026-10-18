"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { RiskForm } from "@/components/forms/risk-form";

type Project = { id: string; name: string };

/**
 * Header action: opens the "New Risk" form in the right push-panel.
 *
 * The form carries its own required Project picker (this register spans every
 * project, so there is no honest default). `defaultProjectId` preselects one —
 * the register's active project filter, so "New Risk" while viewing one
 * project's risks files under that project. It is ignored if it isn't one of
 * `projects`.
 */
export function NewRiskButton({
  projects,
  defaultProjectId,
}: {
  projects: Project[];
  defaultProjectId?: string;
}) {
  const inspector = useInspector();

  function openNew() {
    inspector.open(
      <RiskForm projectId={defaultProjectId ?? ""} projects={projects} />,
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
