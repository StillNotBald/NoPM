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
 *
 * `part` (mobile pass, R-94) splits the header variant in two so the page can
 * hand "Add member" to PageHeader's `action` slot and "Allocate to project"
 * to `secondaryActions` — below `sm` PageHeader collapses secondaryActions
 * into a 44px overflow menu instead of cramming both buttons + the
 * over-allocated badge into one row, which used to push "Add member" past
 * the viewport edge on phones. Omitting `part` renders both, unchanged, for
 * any other caller.
 */
export function ResourceActions({
  variant = "header",
  part,
}: {
  variant?: "header" | "empty-state";
  part?: "primary" | "secondary";
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

  if (part === "primary") {
    return (
      <Button variant="primary" size="sm" onClick={openAddMember}>
        Add member
      </Button>
    );
  }

  if (part === "secondary") {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={openAllocate}
        className="w-full justify-start sm:w-auto sm:justify-center"
      >
        Allocate to project
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
