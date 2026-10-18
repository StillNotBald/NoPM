"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { DecisionForm } from "@/components/decisions/decision-form";

type Project = { id: string; name: string };

/** Header action: opens the "Add Decision" form in the right push-panel. */
export function NewDecisionButton({ projects }: { projects: Project[] }) {
  const inspector = useInspector();

  function openNew() {
    inspector.open(
      <DecisionForm projects={projects} />,
      "Add Decision",
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
      Add Decision
    </Button>
  );
}
