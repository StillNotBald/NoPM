"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { SprintForm } from "@/components/forms/sprint-form";

export function NewSprintButton({
  defaultProjectId,
  variant = "secondary",
  className,
}: {
  defaultProjectId?: string;
  variant?: "primary" | "secondary";
  className?: string;
}) {
  const inspector = useInspector();

  return (
    <Button
      variant={variant}
      className={className ?? "h-11 sm:h-10"}
      onClick={() =>
        inspector.open(<SprintForm defaultProjectId={defaultProjectId} />, "New Sprint")
      }
    >
      <Plus size={16} className="mr-1.5" />
      New Sprint
    </Button>
  );
}
