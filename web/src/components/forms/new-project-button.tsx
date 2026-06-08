"use client";

import { useModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { ProjectForm } from "@/components/forms/project-form";

export function NewProjectButton() {
  const modal = useModal();

  return (
    <Button
      variant="primary"
      onClick={() =>
        modal.open(<ProjectForm mode="create" scaffold />, {
          title: "New Project",
          size: "lg",
        })
      }
    >
      <Plus size={16} className="mr-1.5" />
      New Project
    </Button>
  );
}
