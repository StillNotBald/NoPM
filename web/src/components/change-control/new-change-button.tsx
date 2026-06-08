"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInspector } from "@/components/layout/app-shell";
import { ChangeForm } from "@/components/change-control/change-form";

type Project = { id: string; name: string };

/** Header action: opens the "Raise Change Request" form in the right push-panel. */
export function NewChangeButton({ projects }: { projects: Project[] }) {
  const inspector = useInspector();

  function openNew() {
    inspector.open(
      <ChangeForm projects={projects} />,
      "Raise Change Request",
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
      Raise Change Request
    </Button>
  );
}
