"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { ProgramForm } from "@/components/forms/program-form";

export function NewProgramButton() {
  const inspector = useInspector();

  return (
    <Button
      variant="secondary"
      className="h-11 sm:h-10"
      onClick={() => inspector.open(<ProgramForm mode="create" />, "New Program")}
    >
      <Plus size={16} className="mr-1.5" />
      New Program
    </Button>
  );
}
