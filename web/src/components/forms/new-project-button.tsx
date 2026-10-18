"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { ProjectForm } from "@/components/forms/project-form";

export function NewProjectButton() {
  const inspector = useInspector();

  return (
    <Button
      variant="primary"
      className="h-11 sm:h-10"
      onClick={() =>
        inspector.open(<ProjectForm mode="create" scaffold />, "New Project")
      }
    >
      <Plus size={16} className="mr-1.5" />
      New Project
    </Button>
  );
}
