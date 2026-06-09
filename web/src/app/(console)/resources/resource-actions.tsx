"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { ResourceForm } from "@/components/forms/resource-form";
import { AllocationForm } from "@/components/forms/allocation-form";

/**
 * Client island for the Resources page header + empty-state actions.
 * Kept in a separate "use client" file so the parent server component
 * (page.tsx) can import it without becoming a client component itself.
 *
 * variant="header"     — two side-by-side buttons (Add member + Allocate)
 * variant="empty-state" — single "Add member" button for the empty-state card
 */
export function ResourceActions({
  variant = "header",
}: {
  variant?: "header" | "empty-state";
}) {
  const inspector = useInspector();

  function openAddMember() {
    inspector.open(<ResourceForm />, "Add Team Member");
  }

  function openAllocate() {
    inspector.open(<AllocationForm />, "Allocate to Project");
  }

  if (variant === "empty-state") {
    return (
      <Button variant="primary" size="sm" onClick={openAddMember}>
        Add member
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={openAllocate}>
        Allocate to project
      </Button>
      <Button variant="primary" size="sm" onClick={openAddMember}>
        Add member
      </Button>
    </>
  );
}
